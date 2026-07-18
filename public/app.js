// redgpt frontend — vanilla JS
const chatEl = document.getElementById("chat");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const resetEl = document.getElementById("reset");
const popEl = document.getElementById("popover");
const backendEl = document.getElementById("backend");
backendEl.value = localStorage.getItem("redgpt-backend") || "claude";
backendEl.onchange = () => localStorage.setItem("redgpt-backend", backendEl.value);

// state.messages: {role:'user', text} | {role:'assistant', versions:[{vid, words:[...]}], cur}
const state = { messages: [] };
const vidIndex = new Map(); // vid -> {mi, vi}
const streams = new Map(); // vid -> EventSource

const OPENAI_HIGHLIGHT_N = 3; // only highlight the N shakiest words in gpt view

// For the openai backend: indices of the N lowest-probability words
// (that are actually ambiguous). Returns null for the claude backend.
function computeHi(v) {
  if (!v || v.backend !== "openai") return null;
  const idx = v.words
    .map((w, i) => ({ i, p: w.prob }))
    .filter((x) => x.p != null && x.p < 0.9)
    .sort((a, b) => a.p - b.p)
    .slice(0, OPENAI_HIGHLIGHT_N)
    .map((x) => x.i);
  return new Set(idx);
}

function confClass(w) {
  if (!w.done) return "pending";
  if (w.prob != null) {
    if (w.prob >= 0.95) return "ok";
    if (w.prob >= 0.8) return "warn1";
    if (w.prob >= 0.5) return "warn2";
    return "bad";
  }
  if (w.reached === 0) return "unknown";
  const r = w.matched / w.reached;
  if (r >= 0.999) return "ok";
  if (r >= 0.67) return "warn1";
  if (r >= 0.34) return "warn2";
  return "bad";
}

function pct(p) {
  return p >= 0.1 ? `${Math.round(p * 100)}%` : `${(p * 100).toFixed(1)}%`;
}

function wordTitle(w) {
  if (!w.done) return "checking…";
  if (w.prob != null) return `${pct(w.prob)} probability`;
  if (w.reached === 0) return "no probe reached this word";
  return `${w.matched}/${w.reached} probes agreed`;
}

function renderWord(mi, vi, i, w) {
  const span = document.createElement("span");
  span.id = `w-${mi}-${vi}-${i}`;
  span.textContent = w.text;
  applyWord(span, w, mi, vi, i);
  return span;
}

function applyWord(span, w, mi, vi, i) {
  const v = state.messages[mi].versions[vi];
  const limited = v.backend === "openai"; // gpt view: only highlight top-N shaky words
  const highlighted = !limited || (v.hi && v.hi.has(i));
  const cls = highlighted ? confClass(w) : "plain";
  const clickable = highlighted && w.alts && w.alts.length > 0;
  span.className = `w ${cls}${clickable ? " clickable" : ""}`;
  span.title = wordTitle(w);
  span.onclick = clickable ? (ev) => showPopover(ev, mi, vi, i) : null;
}

function renderMessage(mi) {
  const m = state.messages[mi];
  const div = document.createElement("div");
  div.className = `msg ${m.role}`;
  div.id = `msg-${mi}`;
  if (m.role === "user") {
    div.textContent = m.text;
    return div;
  }
  const vi = m.cur;
  const v = m.versions[vi];
  v.hi = computeHi(v);
  const body = document.createElement("div");
  body.className = "body";
  v.words.forEach((w, i) => {
    body.appendChild(renderWord(mi, vi, i, w));
    body.appendChild(document.createTextNode(" "));
  });
  div.appendChild(body);
  const meta = document.createElement("div");
  meta.className = "meta";
  if (m.versions.length > 1) {
    const prev = document.createElement("button");
    prev.textContent = "‹";
    prev.disabled = vi === 0;
    prev.onclick = () => { m.cur = vi - 1; rerenderMessage(mi); };
    const label = document.createElement("span");
    label.textContent = `branch ${vi + 1}/${m.versions.length}`;
    const next = document.createElement("button");
    next.textContent = "›";
    next.disabled = vi === m.versions.length - 1;
    next.onclick = () => { m.cur = vi + 1; rerenderMessage(mi); };
    meta.append(prev, label, next);
  }
  const tag = document.createElement("span");
  tag.textContent = v.backend === "openai" ? "openai" : "claude";
  meta.appendChild(tag);
  const status = document.createElement("span");
  status.id = `status-${mi}-${vi}`;
  status.textContent = v.probing ? "probing…" : "";
  meta.appendChild(status);
  if (v.probing) {
    const stop = document.createElement("button");
    stop.textContent = "stop";
    stop.onclick = () => fetch(`/api/stop/${v.vid}`, { method: "POST" });
    meta.appendChild(stop);
  }
  div.appendChild(meta);
  return div;
}

function rerenderMessage(mi) {
  const old = document.getElementById(`msg-${mi}`);
  const fresh = renderMessage(mi);
  if (old) old.replaceWith(fresh);
  else chatEl.appendChild(fresh);
}

function renderAll() {
  chatEl.innerHTML = "";
  state.messages.forEach((_, mi) => chatEl.appendChild(renderMessage(mi)));
  chatEl.scrollTop = chatEl.scrollHeight;
}

function openStream(vid) {
  if (streams.has(vid)) return;
  const es = new EventSource(`/api/stream/${vid}`);
  streams.set(vid, es);
  es.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    const loc = vidIndex.get(vid);
    if (!loc) return;
    const m = state.messages[loc.mi];
    const v = m.versions[loc.vi];
    if (d.type === "word") {
      const w = v.words[d.i];
      w.matched = d.matched; w.reached = d.reached; w.done = d.done; w.alts = d.alts;
      if (m.cur === loc.vi) {
        const span = document.getElementById(`w-${loc.mi}-${loc.vi}-${d.i}`);
        if (span) applyWord(span, w, loc.mi, loc.vi, d.i);
      }
    } else if (d.type === "done") {
      v.probing = false;
      es.close();
      streams.delete(vid);
      if (m.cur === loc.vi) rerenderMessage(loc.mi);
    }
  };
  es.onerror = () => { /* EventSource auto-reconnects; buffered replay makes it safe */ };
}

function addAssistant(mi, data) {
  // data: {vid, backend, words}
  const m = state.messages[mi];
  const vi = m.versions.length;
  m.versions.push({ vid: data.vid, backend: data.backend, words: data.words, probing: data.backend !== "openai" });
  m.cur = vi;
  vidIndex.set(data.vid, { mi, vi });
  rerenderMessage(mi);
  chatEl.scrollTop = chatEl.scrollHeight;
  openStream(data.vid);
}

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  sendEl.disabled = true;
  inputEl.disabled = true;
  state.messages.push({ role: "user", text });
  const umi = state.messages.length - 1;
  chatEl.appendChild(renderMessage(umi));
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.textContent = "thinking…";
  chatEl.appendChild(typing);
  chatEl.scrollTop = chatEl.scrollHeight;
  try {
    const res = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, backend: backendEl.value }),
    });
    const data = await res.json();
    typing.remove();
    if (data.error) throw new Error(data.error);
    state.messages.push({ role: "assistant", versions: [], cur: 0 });
    addAssistant(state.messages.length - 1, data);
  } catch (e) {
    typing.textContent = `error: ${e.message}`;
    typing.className = "typing";
  } finally {
    sendEl.disabled = false;
    inputEl.disabled = false;
    inputEl.focus();
  }
}

function showPopover(ev, mi, vi, i) {
  ev.stopPropagation();
  const m = state.messages[mi];
  const v = m.versions[vi];
  const w = v.words[i];
  popEl.innerHTML = "";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent =
    w.prob != null
      ? `alternatives for "${w.text}" (${pct(w.prob)}) — click to branch`
      : `alternatives for "${w.text}" (${w.matched}/${w.reached} agreed) — click to branch`;
  popEl.appendChild(title);
  for (const alt of w.alts) {
    const div = document.createElement("div");
    div.className = "alt";
    const b = document.createElement("b");
    b.textContent = alt.phrase[0];
    div.appendChild(b);
    if (alt.phrase.length > 1) {
      const rest = document.createElement("span");
      rest.className = "rest";
      rest.textContent = " " + alt.phrase.slice(1).join(" ") + "…";
      div.appendChild(rest);
    }
    const c = document.createElement("span");
    c.className = "count";
    c.textContent = alt.prob != null ? pct(alt.prob) : alt.count > 1 ? `×${alt.count}` : "";
    if (c.textContent) div.appendChild(c);
    div.onclick = () => branch(mi, vi, i, alt.phrase, alt.prob);
    popEl.appendChild(div);
  }
  popEl.classList.remove("hidden");
  const rect = ev.target.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 6;
  let left = rect.left + window.scrollX;
  popEl.style.top = `${top}px`;
  popEl.style.left = `${left}px`;
  // keep on screen
  requestAnimationFrame(() => {
    const pr = popEl.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) {
      popEl.style.left = `${Math.max(8, window.innerWidth - pr.width - 8)}px`;
    }
  });
}

document.addEventListener("click", () => popEl.classList.add("hidden"));
popEl.addEventListener("click", (e) => e.stopPropagation());

async function branch(mi, vi, i, phrase, prob) {
  popEl.classList.add("hidden");
  const m = state.messages[mi];
  const v = m.versions[vi];
  const msgDiv = document.getElementById(`msg-${mi}`);
  if (msgDiv) msgDiv.classList.add("branching");
  try {
    const res = await fetch("/api/branch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vid: v.vid, pos: i, phrase, prob }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    addAssistant(mi, data);
  } catch (e) {
    alert(`branch failed: ${e.message}`);
  } finally {
    const d = document.getElementById(`msg-${mi}`);
    if (d) d.classList.remove("branching");
  }
}

resetEl.onclick = async () => {
  await fetch("/api/reset", { method: "POST" });
  state.messages.length = 0;
  vidIndex.clear();
  for (const es of streams.values()) es.close();
  streams.clear();
  renderAll();
};

sendEl.onclick = send;
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") send();
});
inputEl.focus();
