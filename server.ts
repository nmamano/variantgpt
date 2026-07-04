// redgpt — chat where words are colored by how "probable" they are.
// Since the Claude subscription gives no logprobs, we estimate confidence by
// sampling: K probe calls predict the continuation at each point of the answer;
// agreement with the actual answer = confidence, divergent probes = alternatives.

const HOME = process.env.HOME ?? "/home/nil";
const CLAUDE = `${HOME}/.local/bin/claude`;
const PORT = 4777;
const MODEL = "haiku";
const K = 2; // probes per anchor (Nil's "generate twice" → gradient 0/2,1/2,2/2)
const STRIDE = 18; // words each probe predicts forward from its anchor
const ANCHOR_STEP = 9; // start a fresh anchor every N words (overlapping windows)
const MAX_WAVES = 2; // shallow follow-up; overlap does most of the coverage work
const MAX_PROBE_CALLS = 20; // hard budget of probe calls per answer
const MAX_PROBE_MS = 90_000; // hard wall-clock deadline; auto-stops after this
const PROBE_TIMEOUT_MS = 22_000; // kill a stuck probe so it can't hog a slot
// Counterintuitive but measured: on the shared box, 12 parallel claude spawns
// balloon each call from ~3.5s to 6-60s. Keeping concurrency low keeps each
// call fast, which gives BETTER total throughput.
const MAX_CONCURRENT = 4; // parallel claude processes
const GEN_WORD_CAP = 40; // short answers fully color within the time budget (claude backend)
const GEN_WORD_CAP_OPENAI = 100; // openai logprobs are free/instant, allow longer answers
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

async function openaiKey(): Promise<string | null> {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    // re-read .env on every call so the key can be dropped in without a restart
    const t = await Bun.file(`${import.meta.dir}/.env`).text();
    const m = t.match(/^OPENAI_API_KEY\s*=\s*(\S+)\s*$/m);
    if (m) return m[1];
  } catch {}
  return null;
}

// ---------- concurrency ----------
class Semaphore {
  private waiters: (() => void)[] = [];
  constructor(private n: number) {}
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  release() {
    const w = this.waiters.shift();
    if (w) w();
    else this.n++;
  }
}
const sem = new Semaphore(MAX_CONCURRENT);

async function claudeText(prompt: string, label = "call", timeoutMs = 120_000): Promise<string> {
  const tQueue = Date.now();
  await sem.acquire();
  const tStart = Date.now();
  try {
    const proc = Bun.spawn(
      [CLAUDE, "-p", "--model", MODEL, "--strict-mcp-config", "--effort", "low", prompt],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timer);
    const code = await proc.exited;
    const now = Date.now();
    console.log(
      `[claude ${label}] queued=${((tStart - tQueue) / 1000).toFixed(1)}s run=${((now - tStart) / 1000).toFixed(1)}s exit=${code}`,
    );
    if (code !== 0) throw new Error(`claude exited ${code}: ${err.slice(0, 300)}`);
    return out.trim();
  } finally {
    sem.release();
  }
}

// ---------- data model ----------
type Alt = { phrase: string[]; count: number; prob?: number };
type Word = {
  text: string;
  matched: number; // probes that agreed with this word (claude backend)
  reached: number; // probes that evaluated this position (claude backend)
  done: boolean; // probing finished for this position
  alts: Alt[];
  prob?: number | null; // exact probability (openai backend; min over the word's tokens)
};
type Backend = "claude" | "openai";
type Ctx = { transcript: string; lastUser: string };
type Version = {
  vid: string;
  words: Word[];
  ctx: Ctx;
  backend: Backend;
  probing: boolean;
  stopped: boolean;
  bus: Bus;
};
type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; versions: Version[]; cur: number };

const messages: Msg[] = [];
const versionsById = new Map<string, Version>();
let nextId = 1;

class Bus {
  events: string[] = [];
  subs = new Set<(s: string) => void>();
  push(obj: unknown) {
    const s = JSON.stringify(obj);
    this.events.push(s);
    for (const f of this.subs) f(s);
  }
}

function splitWords(text: string): string[] {
  return text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}
function normalize(w: string): string {
  const n = w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return n || w.toLowerCase();
}
function makeWords(texts: string[]): Word[] {
  return texts.map((t) => ({ text: t, matched: 0, reached: 0, done: false, alts: [] }));
}
function makeVersion(texts: string[], ctx: Ctx, backend: Backend = "claude"): Version {
  const v: Version = {
    vid: `v${nextId++}`,
    words: makeWords(texts),
    ctx,
    backend,
    probing: backend === "claude",
    stopped: false,
    bus: new Bus(),
  };
  versionsById.set(v.vid, v);
  return v;
}
function wordPayload(w: Word) {
  return { text: w.text, matched: w.matched, reached: w.reached, done: w.done, alts: w.alts, prob: w.prob ?? null };
}
function versionText(v: Version): string {
  return v.words.map((w) => w.text).join(" ");
}
function buildTranscript(): string {
  let out = "";
  for (const m of messages) {
    if (m.role === "user") out += `User: ${m.text}\n`;
    else out += `Assistant: ${versionText(m.versions[m.cur])}\n`;
  }
  return out || "(no prior messages)";
}

// ---------- prompts ----------
function genPrompt(ctx: Ctx): string {
  return `You are a helpful chat assistant. Keep your answer under ${GEN_WORD_CAP} words. Write plain flowing prose only — no markdown, no lists, no headers, no code blocks.

Conversation so far:
${ctx.transcript}
User: ${ctx.lastUser}

Write the assistant's reply now. Output ONLY the reply text.`;
}

function probePrompt(ctx: Ctx, prefix: string): string {
  const begin = prefix
    ? `The assistant's reply begins:\n"${prefix}"\n\nOutput ONLY the next ${STRIDE} words that most naturally continue this reply.`
    : `The assistant has not started the reply yet. Output ONLY the first ${STRIDE} words of the most natural reply.`;
  return `You are predicting the exact continuation of an assistant's reply in a conversation. The assistant writes plain flowing prose (no markdown), under ${GEN_WORD_CAP} words total.

Conversation:
${ctx.transcript}
User: ${ctx.lastUser}

${begin} No quotes, no commentary, just the words.`;
}

function branchPrompt(ctx: Ctx, soFar: string): string {
  return `You are a helpful chat assistant writing plain flowing prose (no markdown), under ${GEN_WORD_CAP} words total.

Conversation:
${ctx.transcript}
User: ${ctx.lastUser}

The assistant's reply so far:
"${soFar}"

Continue this reply from exactly where it stops, to a natural ending. Output ONLY the continuation — do not repeat the existing text. If the reply already looks complete, output a single period.`;
}

// ---------- openai backend (true logprobs) ----------
type TokLP = { token: string; logprob: number; top_logprobs?: { token: string; logprob: number }[] };

function openaiMessages(ctx: Ctx): { role: string; content: string }[] {
  return [
    {
      role: "system",
      content: `You are a helpful chat assistant. Keep your answer under ${GEN_WORD_CAP_OPENAI} words. Write plain flowing prose only — no markdown, no lists, no headers.`,
    },
    {
      role: "user",
      content: `Conversation so far:\n${ctx.transcript}\nUser: ${ctx.lastUser}\n\nWrite the assistant's reply now. Output ONLY the reply text.`,
    },
  ];
}

async function openaiChat(msgs: { role: string; content: string }[]): Promise<{ content: string; toks: TokLP[] }> {
  const key = await openaiKey();
  if (!key) throw new Error("OPENAI_API_KEY not set — drop it in ~/nil/redgpt/.env (OPENAI_API_KEY=sk-...)");
  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: msgs,
      logprobs: true,
      top_logprobs: 8,
      max_completion_tokens: 600,
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as any;
  console.log(`[openai] ${((Date.now() - t0) / 1000).toFixed(1)}s model=${data.model}`);
  const choice = data.choices?.[0];
  return { content: choice?.message?.content ?? "", toks: choice?.logprobs?.content ?? [] };
}

// Reconstruct whitespace-delimited words from subword tokens.
// Word prob = min prob of its tokens (weakest link). Alternatives come from
// the top_logprobs of the word's first token, only for shaky words.
function wordsFromLogprobs(toks: TokLP[]): Word[] {
  let full = "";
  const spans: { start: number; end: number; t: TokLP }[] = [];
  for (const t of toks) {
    spans.push({ start: full.length, end: full.length + t.token.length, t });
    full += t.token;
  }
  const words: Word[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(full))) {
    const ws = m.index;
    const we = ws + m[0].length;
    const overlapping = spans.filter((s) => s.start < we && s.end > ws);
    const prob = overlapping.length
      ? Math.min(...overlapping.map((s) => Math.exp(s.t.logprob)))
      : null;
    const w: Word = { text: m[0], matched: 0, reached: 0, done: true, alts: [], prob };
    if (prob !== null && prob < 0.95) {
      const first = overlapping[0].t;
      for (const alt of first.top_logprobs ?? []) {
        const at = alt.token.trim();
        if (!at) continue;
        if (normalize(at) === normalize(first.token.trim() || first.token)) continue;
        if (normalize(at) === normalize(m[0])) continue;
        const ap = Math.exp(alt.logprob);
        if (ap < 0.01 || w.alts.length >= 5) continue;
        w.alts.push({ phrase: [at], count: 1, prob: ap });
      }
    }
    words.push(w);
  }
  return words;
}

// ---------- probe engine ----------
function addAlt(w: Word, phrase: string[]) {
  if (!phrase.length) return;
  const key = normalize(phrase[0]);
  if (key === normalize(w.text)) return;
  const existing = w.alts.find((a) => normalize(a.phrase[0]) === key);
  if (existing) {
    existing.count++;
    if (phrase.length > existing.phrase.length) existing.phrase = phrase;
  } else if (w.alts.length < 6) {
    w.alts.push({ phrase, count: 1 });
  }
}

// Runs k probes from word index s; compares against the answer word-by-word.
// Returns the first position not covered by any probe (all diverged/ended), or null.
async function runStride(v: Version, s: number, k: number): Promise<number | null> {
  if (v.stopped) return null;
  const prefix = v.words.slice(0, s).map((w) => w.text).join(" ");
  const results = await Promise.allSettled(
    Array.from({ length: k }, () =>
      claudeText(probePrompt(v.ctx, prefix), `probe ${v.vid}@${s}`, PROBE_TIMEOUT_MS),
    ),
  );
  const conts = results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map((r) => splitWords(r.value));
  const end = Math.min(s + STRIDE, v.words.length);
  const probes = conts.map((c) => ({ c, dead: false }));
  if (!probes.length) return s < end ? s : null;

  for (let j = s; j < end; j++) {
    const w = v.words[j];
    let reached = 0;
    for (const p of probes) {
      if (p.dead) continue;
      const pw = p.c[j - s];
      if (pw === undefined) { p.dead = true; continue; }
      reached++;
      if (normalize(pw) === normalize(w.text)) {
        w.matched++;
      } else {
        p.dead = true;
        addAlt(w, p.c.slice(j - s));
      }
    }
    w.reached += reached;
    if (reached > 0) w.done = true;
    v.bus.push({ type: "word", i: j, ...wordPayload(w) });
    if (probes.every((p) => p.dead)) {
      const next = j + 1;
      return next < end ? next : null;
    }
  }
  return null;
}

// Pipelined probing: every stride independently launches its own follow-up
// the moment it resolves — no global barrier between waves.
async function probeVersion(v: Version, startAt = 0) {
  const t0 = Date.now();
  let used = 0;
  let inflight = 0;
  let resolveAll!: () => void;
  const allDone = new Promise<void>((r) => (resolveAll = r));
  const deadline = setTimeout(() => {
    if (v.probing && !v.stopped) {
      v.stopped = true;
      console.log(`[probe ${v.vid}] hit ${MAX_PROBE_MS / 1000}s deadline — auto-stop`);
    }
  }, MAX_PROBE_MS);

  const launch = (s: number, wave: number) => {
    if (v.stopped || s >= v.words.length) return;
    if (wave > MAX_WAVES || used + K > MAX_PROBE_CALLS) return;
    used += K;
    inflight++;
    const ts = Date.now();
    runStride(v, s, K)
      .then((next) => {
        console.log(
          `[stride ${v.vid}] s=${s} wave=${wave} took=${((Date.now() - ts) / 1000).toFixed(1)}s next=${next ?? "-"} used=${used}/${MAX_PROBE_CALLS}`,
        );
        if (next !== null) launch(next, wave + 1);
      })
      .catch((e) => console.error("stride error", e))
      .finally(() => {
        inflight--;
        if (inflight === 0) resolveAll();
      });
  };

  try {
    for (let s = startAt; s < v.words.length; s += ANCHOR_STEP) launch(s, 1);
    if (inflight === 0) resolveAll();
    await allDone;
    console.log(
      `[probe ${v.vid}] finished in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${used} calls${v.stopped ? " (stopped)" : ""}`,
    );
  } catch (e) {
    console.error("probe error", e);
  } finally {
    clearTimeout(deadline);
    for (let i = 0; i < v.words.length; i++) {
      const w = v.words[i];
      if (!w.done) {
        w.done = true; // reached stays 0 => "unknown"
        v.bus.push({ type: "word", i, ...wordPayload(w) });
      }
    }
    v.probing = false;
    v.bus.push({ type: "done" });
  }
}

// ---------- server ----------
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let busy = false;

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/" ) return new Response(Bun.file("public/index.html"));
      if (path === "/app.js") return new Response(Bun.file("public/app.js"));
      if (path === "/style.css") return new Response(Bun.file("public/style.css"));

      if (path === "/api/state") {
        return json({
          messages: messages.map((m) =>
            m.role === "user"
              ? { role: "user", text: m.text }
              : {
                  role: "assistant",
                  cur: m.cur,
                  versions: m.versions.map((v) => ({
                    vid: v.vid,
                    probing: v.probing,
                    words: v.words.map(wordPayload),
                  })),
                },
          ),
        });
      }

      if (path === "/api/reset" && req.method === "POST") {
        messages.length = 0;
        return json({ ok: true });
      }

      if (path === "/api/message" && req.method === "POST") {
        if (busy) return json({ error: "busy" }, 429);
        busy = true;
        try {
          const { text, backend = "claude" } = (await req.json()) as { text: string; backend?: Backend };
          if (!text?.trim()) return json({ error: "empty" }, 400);
          const ctx: Ctx = { transcript: buildTranscript(), lastUser: text.trim() };
          let v: Version;
          if (backend === "openai") {
            const { content, toks } = await openaiChat(openaiMessages(ctx));
            const words = toks.length
              ? wordsFromLogprobs(toks)
              : makeWords(splitWords(content)).map((w) => ({ ...w, done: true }));
            if (!words.length) throw new Error("empty reply");
            messages.push({ role: "user", text: text.trim() });
            v = makeVersion([], ctx, "openai");
            v.words = words;
            v.bus.push({ type: "done" });
          } else {
            const reply = await claudeText(genPrompt(ctx), "generate");
            const words = splitWords(reply);
            if (!words.length) throw new Error("empty reply");
            messages.push({ role: "user", text: text.trim() });
            v = makeVersion(words, ctx);
            probeVersion(v).catch(console.error);
          }
          messages.push({ role: "assistant", versions: [v], cur: 0 });
          return json({ vid: v.vid, backend: v.backend, words: v.words.map(wordPayload) });
        } finally {
          busy = false;
        }
      }

      if (path === "/api/branch" && req.method === "POST") {
        const { vid, pos, phrase, prob } = (await req.json()) as {
          vid: string;
          pos: number;
          phrase: string[];
          prob?: number;
        };
        const v = versionsById.get(vid);
        if (!v) return json({ error: "unknown version" }, 404);
        const msg = messages.find(
          (m): m is Extract<Msg, { role: "assistant" }> =>
            m.role === "assistant" && m.versions.some((x) => x.vid === vid),
        );
        if (!msg) return json({ error: "unknown message" }, 404);
        const prefixTexts = v.words.slice(0, pos).map((w) => w.text);
        const soFar = [...prefixTexts, ...phrase].join(" ");
        let v2: Version;
        if (v.backend === "openai") {
          const msgs = [
            ...openaiMessages(v.ctx),
            { role: "assistant", content: soFar },
            {
              role: "user",
              content:
                "Continue your reply exactly from where it stopped. Output ONLY the continuation — do not repeat any earlier text. If the reply already looks complete, output a single period.",
            },
          ];
          const { toks, content } = await openaiChat(msgs);
          const contWords = (toks.length
            ? wordsFromLogprobs(toks)
            : makeWords(splitWords(content)).map((w) => ({ ...w, done: true }))
          ).filter((w) => w.text !== ".");
          v2 = makeVersion([], v.ctx, "openai");
          v2.words = [
            ...v.words.slice(0, pos).map((src) => ({ ...src, alts: src.alts.map((a) => ({ ...a })) })),
            ...phrase.map((t) => ({ text: t, matched: 0, reached: 0, done: true, alts: [], prob: prob ?? null })),
            ...contWords,
          ];
          v2.bus.push({ type: "done" });
        } else {
          const cont = await claudeText(branchPrompt(v.ctx, soFar), "branch");
          const contWords = splitWords(cont).filter((w) => w !== ".");
          v2 = makeVersion([...prefixTexts, ...phrase, ...contWords], v.ctx);
          // carry over probe evidence for the untouched prefix
          for (let i = 0; i < pos; i++) {
            const src = v.words[i];
            v2.words[i] = { ...src, alts: src.alts.map((a) => ({ ...a })) };
          }
          probeVersion(v2, pos).catch(console.error);
        }
        msg.versions.push(v2);
        msg.cur = msg.versions.length - 1;
        return json({ vid: v2.vid, backend: v2.backend, words: v2.words.map(wordPayload) });
      }

      const stopMatch = path.match(/^\/api\/stop\/(v\d+)$/);
      if (stopMatch && req.method === "POST") {
        const v = versionsById.get(stopMatch[1]);
        if (!v) return json({ error: "unknown version" }, 404);
        v.stopped = true;
        return json({ ok: true });
      }

      const streamMatch = path.match(/^\/api\/stream\/(v\d+)$/);
      if (streamMatch) {
        const v = versionsById.get(streamMatch[1]);
        if (!v) return json({ error: "unknown version" }, 404);
        const bus = v.bus;
        let sub: ((s: string) => void) | null = null;
        let hb: ReturnType<typeof setInterval> | null = null;
        const stream = new ReadableStream({
          start(controller) {
            const send = (s: string) => {
              try {
                controller.enqueue(`data: ${s}\n\n`);
              } catch {}
            };
            for (const e of bus.events) send(e);
            if (!v.probing) {
              // done event already in buffer; nothing more will come
            }
            sub = send;
            bus.subs.add(send);
            hb = setInterval(() => {
              try {
                controller.enqueue(`: hb\n\n`);
              } catch {}
            }, 15000);
          },
          cancel() {
            if (sub) bus.subs.delete(sub);
            if (hb) clearInterval(hb);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: String(e) }, 500);
    }
  },
});

console.log(`redgpt listening on http://0.0.0.0:${server.port} (model: ${MODEL}, K=${K}, stride=${STRIDE})`);
