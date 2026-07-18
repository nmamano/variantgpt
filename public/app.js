// VariantGPT frontend — vanilla JS, OpenAI logprobs backend
const chatEl = document.getElementById("chat");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const resetEl = document.getElementById("reset");
const popEl = document.getElementById("popover");
const threshEl = document.getElementById("thresh");
const threshValEl = document.getElementById("threshVal");

// how many of the least-certain words to highlight (live slider)
let highlightN = parseInt(localStorage.getItem("variantgpt-thresh") ?? "3", 10);
threshEl.value = String(highlightN);
threshValEl.textContent = String(highlightN);
threshEl.oninput = () => {
  highlightN = parseInt(threshEl.value, 10);
  threshValEl.textContent = String(highlightN);
  localStorage.setItem("variantgpt-thresh", String(highlightN));
  renderAll(); // recolor in place
};

// state.messages: {role:'user', text} | {role:'assistant', versions:[{vid, words:[...]}], cur}
const state = { messages: [] };

function pct(p) {
  if (p == null) return "—";
  return p >= 0.1 ? `${Math.round(p * 100)}%` : `${(p * 100).toFixed(1)}%`;
}

function confClass(w) {
  if (w.prob == null) return "plain";
  if (w.prob >= 0.95) return "ok";
  if (w.prob >= 0.8) return "warn1";
  if (w.prob >= 0.5) return "warn2";
  return "bad";
}

// indices of the N lowest-probability words (the ones worth flagging)
function computeHi(v) {
  const idx = v.words
    .map((w, i) => ({ i, p: w.prob }))
    .filter((x) => x.p != null)
    .sort((a, b) => a.p - b.p)
    .slice(0, highlightN)
    .map((x) => x.i);
  return new Set(idx);
}

function applyWord(span, w, v, mi, vi, i) {
  const highlighted = v.hi.has(i);
  const cls = highlighted ? confClass(w) : "plain";
  const clickable = highlighted && w.alts && w.alts.length > 0;
  span.className = `w ${cls}${clickable ? " clickable" : ""}`;
  span.title = highlighted ? `${pct(w.prob)} probability` : "";
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
    const span = document.createElement("span");
    span.id = `w-${mi}-${vi}-${i}`;
    span.textContent = w.text;
    applyWord(span, w, v, mi, vi, i);
    body.appendChild(span);
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

function addAssistant(mi, data) {
  const m = state.messages[mi];
  m.versions.push({ vid: data.vid, words: data.words });
  m.cur = m.versions.length - 1;
  rerenderMessage(mi);
  chatEl.scrollTop = chatEl.scrollHeight;
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
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    typing.remove();
    if (data.error) throw new Error(data.error);
    state.messages.push({ role: "assistant", versions: [], cur: 0 });
    addAssistant(state.messages.length - 1, data);
  } catch (e) {
    typing.textContent = `error: ${e.message}`;
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
  title.textContent = `"${w.text}" · ${pct(w.prob)} — pick a variant to branch`;
  popEl.appendChild(title);
  w.alts.forEach((alt, ai) => {
    const div = document.createElement("div");
    div.className = "alt";
    const head = document.createElement("div");
    head.className = "althead";
    const b = document.createElement("b");
    b.textContent = alt.phrase[0];
    head.appendChild(b);
    const c = document.createElement("span");
    c.className = "count";
    c.textContent = pct(alt.prob);
    head.appendChild(c);
    div.appendChild(head);
    const prev = document.createElement("div");
    prev.className = "preview";
    prev.textContent = alt.preview != null ? `…${alt.preview}…` : "generating…";
    if (alt.preview == null) prev.classList.add("loading");
    div.appendChild(prev);
    div.onclick = () => branch(mi, vi, i, alt.phrase, alt.prob);
    popEl.appendChild(div);
    if (alt.preview == null) loadPreview(v.vid, i, alt, prev);
  });
  popEl.classList.remove("hidden");
  const rect = ev.target.getBoundingClientRect();
  popEl.style.top = `${rect.bottom + window.scrollY + 6}px`;
  popEl.style.left = `${rect.left + window.scrollX}px`;
  requestAnimationFrame(() => {
    const pr = popEl.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) {
      popEl.style.left = `${Math.max(8, window.innerWidth - pr.width - 8)}px`;
    }
  });
}

async function loadPreview(vid, pos, alt, el) {
  try {
    const res = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vid, pos, token: alt.phrase[0] }),
    });
    const data = await res.json();
    alt.preview = data.preview ?? "";
    el.classList.remove("loading");
    el.textContent = alt.preview ? `…${alt.preview}…` : "(ends here)";
  } catch {
    el.classList.remove("loading");
    el.textContent = "(preview failed)";
  }
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
  renderAll();
};

sendEl.onclick = send;
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") send();
});
inputEl.focus();
