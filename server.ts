// VariantGPT — chat where each answer word is colored by its probability
// (from OpenAI logprobs). Click a word to preview and branch into the
// alternatives the model considered.

const PORT = 4777;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GEN_WORD_CAP = 100;
const ALT_MAX = 6; // max alternatives kept per word
const ALT_MIN_PROB = 0.005; // ignore vanishingly unlikely alternatives
const ALT_WORD_CEIL = 0.985; // only compute alts for words below this probability
const PREVIEW_WORDS = 6; // words of continuation shown per variant in the hover menu

async function openaiKey(): Promise<string | null> {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    // re-read .env each call so the key can be dropped in without a restart
    const t = await Bun.file(`${import.meta.dir}/.env`).text();
    const m = t.match(/^OPENAI_API_KEY\s*=\s*(\S+)\s*$/m);
    if (m) return m[1];
  } catch {}
  return null;
}

// ---------- data model ----------
type Alt = { phrase: string[]; prob: number; preview?: string };
type Word = { text: string; prob: number | null; alts: Alt[] };
type Ctx = { transcript: string; lastUser: string };
type Version = { vid: string; words: Word[]; ctx: Ctx };
type Msg = { role: "user"; text: string } | { role: "assistant"; versions: Version[]; cur: number };

const messages: Msg[] = [];
const versionsById = new Map<string, Version>();
let nextId = 1;

function splitWords(text: string): string[] {
  return text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}
function normalize(w: string): string {
  const n = w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return n || w.toLowerCase();
}
function makeVersion(words: Word[], ctx: Ctx): Version {
  const v: Version = { vid: `v${nextId++}`, words, ctx };
  versionsById.set(v.vid, v);
  return v;
}
function wordPayload(w: Word) {
  return { text: w.text, prob: w.prob, alts: w.alts };
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

// ---------- openai ----------
type TokLP = { token: string; logprob: number; top_logprobs?: { token: string; logprob: number }[] };

function openaiMessages(ctx: Ctx): { role: string; content: string }[] {
  return [
    {
      role: "system",
      content: `You are a helpful chat assistant. Keep your answer under ${GEN_WORD_CAP} words. Write plain flowing prose only — no markdown, no lists, no headers.`,
    },
    {
      role: "user",
      content: `Conversation so far:\n${ctx.transcript}\nUser: ${ctx.lastUser}\n\nWrite the assistant's reply now. Output ONLY the reply text.`,
    },
  ];
}

async function openaiChat(
  msgs: { role: string; content: string }[],
  opts: { logprobs?: boolean; maxTokens?: number } = {},
): Promise<{ content: string; toks: TokLP[] }> {
  const key = await openaiKey();
  if (!key) throw new Error("OPENAI_API_KEY not set — add it to ~/nil/variantgpt/.env (OPENAI_API_KEY=sk-...)");
  const t0 = Date.now();
  const body: any = { model: OPENAI_MODEL, messages: msgs, max_completion_tokens: opts.maxTokens ?? 600 };
  if (opts.logprobs) {
    body.logprobs = true;
    body.top_logprobs = 8;
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as any;
  console.log(`[openai] ${((Date.now() - t0) / 1000).toFixed(1)}s model=${data.model}`);
  const choice = data.choices?.[0];
  return { content: choice?.message?.content ?? "", toks: choice?.logprobs?.content ?? [] };
}

// Reconstruct whitespace-delimited words from subword tokens.
// Word prob = min prob over its tokens (weakest link). Alternatives come from
// the top_logprobs of the word's first token, kept for all but near-certain words.
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
    const prob = overlapping.length ? Math.min(...overlapping.map((s) => Math.exp(s.t.logprob))) : null;
    const w: Word = { text: m[0], prob, alts: [] };
    if (prob !== null && prob < ALT_WORD_CEIL && overlapping.length) {
      const first = overlapping[0].t;
      for (const alt of first.top_logprobs ?? []) {
        const at = alt.token.trim();
        if (!at) continue;
        if (normalize(at) === normalize(first.token.trim() || first.token)) continue;
        if (normalize(at) === normalize(m[0])) continue;
        const ap = Math.exp(alt.logprob);
        if (ap < ALT_MIN_PROB || w.alts.length >= ALT_MAX) continue;
        w.alts.push({ phrase: [at], prob: ap });
      }
    }
    words.push(w);
  }
  return words;
}

function fallbackWords(text: string): Word[] {
  return splitWords(text).map((t) => ({ text: t, prob: null, alts: [] }));
}

// Continue the reply after `soFar`; returns fresh words (with logprobs).
async function continueFrom(ctx: Ctx, soFar: string, maxTokens = 600): Promise<Word[]> {
  const msgs = [
    ...openaiMessages(ctx),
    { role: "assistant", content: soFar },
    {
      role: "user",
      content:
        "Continue your reply exactly from where it stopped. Output ONLY the continuation — do not repeat any earlier text. If the reply already looks complete, output a single period.",
    },
  ];
  const { toks, content } = await openaiChat(msgs, { logprobs: true, maxTokens });
  return (toks.length ? wordsFromLogprobs(toks) : fallbackWords(content)).filter((w) => w.text !== ".");
}

// When a word is replaced by `chosen`, the new word stays clickable: its
// siblings are the original word plus the other alternatives (minus chosen).
function siblingAlts(parent: Word, chosen: string): Alt[] {
  const out: Alt[] = [];
  if (normalize(parent.text) !== normalize(chosen)) {
    out.push({ phrase: [parent.text], prob: parent.prob ?? 0 });
  }
  for (const a of parent.alts) {
    if (normalize(a.phrase[0]) !== normalize(chosen)) out.push({ ...a });
  }
  return out;
}

// ---------- server ----------
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

let busy = false;

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/") return new Response(Bun.file("public/index.html"));
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
                  versions: m.versions.map((v) => ({ vid: v.vid, words: v.words.map(wordPayload) })),
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
          const { text } = (await req.json()) as { text: string };
          if (!text?.trim()) return json({ error: "empty" }, 400);
          const ctx: Ctx = { transcript: buildTranscript(), lastUser: text.trim() };
          const { content, toks } = await openaiChat(openaiMessages(ctx), { logprobs: true });
          const words = toks.length ? wordsFromLogprobs(toks) : fallbackWords(content);
          if (!words.length) throw new Error("empty reply");
          messages.push({ role: "user", text: text.trim() });
          const v = makeVersion(words, ctx);
          messages.push({ role: "assistant", versions: [v], cur: 0 });
          return json({ vid: v.vid, words: v.words.map(wordPayload) });
        } finally {
          busy = false;
        }
      }

      // Generate the first few words of continuation for a candidate variant,
      // shown inline in the hover menu. Cached on the alt so it's computed once.
      if (path === "/api/preview" && req.method === "POST") {
        const { vid, pos, token } = (await req.json()) as { vid: string; pos: number; token: string };
        const v = versionsById.get(vid);
        if (!v) return json({ error: "unknown version" }, 404);
        const alt = v.words[pos]?.alts.find((a) => a.phrase[0] === token);
        if (alt?.preview !== undefined) return json({ preview: alt.preview });
        const prefixText = v.words.slice(0, pos).map((w) => w.text).join(" ");
        const soFar = (prefixText ? prefixText + " " : "") + token;
        const contWords = await continueFrom(v.ctx, soFar, 24);
        const preview = contWords.slice(0, PREVIEW_WORDS).map((w) => w.text).join(" ");
        if (alt) alt.preview = preview;
        return json({ preview });
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
        const parent = v.words[pos];
        const chosen = phrase[0];
        const prefixWords = v.words.slice(0, pos).map((w) => ({ ...w, alts: w.alts.map((a) => ({ ...a })) }));
        const prefixText = prefixWords.map((w) => w.text).join(" ");
        const soFar = (prefixText ? prefixText + " " : "") + phrase.join(" ");
        const contWords = await continueFrom(v.ctx, soFar);
        const chosenWord: Word = {
          text: phrase.join(" "),
          prob: prob ?? null,
          alts: parent ? siblingAlts(parent, chosen) : [],
        };
        const v2 = makeVersion([...prefixWords, chosenWord, ...contWords], v.ctx);
        msg.versions.push(v2);
        msg.cur = msg.versions.length - 1;
        return json({ vid: v2.vid, words: v2.words.map(wordPayload) });
      }

      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: String(e) }, 500);
    }
  },
});

console.log(`VariantGPT listening on http://0.0.0.0:${server.port} (model: ${OPENAI_MODEL})`);
