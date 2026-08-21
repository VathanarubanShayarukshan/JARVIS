"use strict";

const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) => {
  const headers = Object.assign({}, opts.headers || {});
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  let finalBody = opts.body;
  if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    finalBody = JSON.stringify(opts.body);
  }
  return fetch(path, Object.assign({}, opts, { headers, body: finalBody }));
};
const json = async (r) => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.statusText || "request failed");
  return j;
};

const state = {
  token: localStorage.getItem("token") || "",
  sessionId: null,
  sessions: [],
  providers: [],
  busy: false,
  autoTitle: true,
  modelKey: localStorage.getItem("modelKey") || "",
  modelPrefs: JSON.parse(localStorage.getItem("modelPrefs") || "{}"),
  abort: null,
  ctrl: null,
  pendingFiles: [], // {name, file} waiting to be attached to the next message
};

const uiState = { activity: null, answer: "", toolCount: 0 };

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ---------------- tiny markdown renderer (no external deps) ---------------- */

function renderMarkdown(src) {
  let text = String(src || "");
  const blocks = [];
  text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length;
    blocks.push(
      `<pre><button class="copy-btn" data-code="${i}">copy</button><code class="lang-${esc(lang)}">${esc(code)}</code></pre>`
    );
    return `\u0000B${i}\u0000`;
  });
  let out = "";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("# ")) out += `<h1>${inline(t.slice(2))}</h1>`;
    else if (t.startsWith("## ")) out += `<h2>${inline(t.slice(3))}</h2>`;
    else if (t.startsWith("### ")) out += `<h3>${inline(t.slice(4))}</h3>`;
    else if (t.startsWith("> ")) out += `<blockquote>${inline(t.slice(2))}</blockquote>`;
    else if (/^[-*] /.test(t)) out += `<li>${inline(t.slice(2))}</li>`;
    else if (/^\d+\. /.test(t)) out += `<li>${inline(t.replace(/^\d+\. /, ""))}</li>`;
    else if (t === "---" || t === "***") out += "<hr>";
    else if (t === "") out += out.endsWith("</li>") ? "" : "\u0000P\u0000";
    else out += `<p>${inline(line)}</p>`;
  }
  out = out.replace(/\u0000P\u0000/g, "<p></p>").replace(/<li>/g, "<ul><li>")
    .replace(/<\/li>(?!<li>|\u0000)/g, "</li></ul>");
  return out.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[i]);
}

const inline = (s) => {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
};

/* ---------------- screens & boot ---------------- */

function showScreen(name) {
  ["setup-screen", "login-screen", "app"].forEach((id) => $(id).classList.toggle("hidden", id !== name));
}

async function boot() {
  const health = await json(await fetch("/api/health"));
  if (!health.setup_done) { showScreen("setup-screen"); return; }
  if (!state.token) { showScreen("login-screen"); return; }
  try {
    await loadAll();
    showScreen("app");
  } catch {
    state.token = "";
    localStorage.removeItem("token");
    showScreen("login-screen");
  }
}

$("setup-btn").onclick = async () => {
  const r = await api("/api/auth/setup", { method: "POST", body: { password: $("setup-password").value } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("setup-error").textContent = j.detail || "failed"; return; }
  state.token = j.token;
  localStorage.setItem("token", j.token);
  await loadAll();
  showScreen("app");
};

$("login-btn").onclick = async () => {
  const r = await api("/api/auth/login", { method: "POST", body: { password: $("login-password").value } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("login-error").textContent = j.detail || "failed"; return; }
  state.token = j.token;
  localStorage.setItem("token", j.token);
  await loadAll();
  showScreen("app");
};
$("login-password").addEventListener("keydown", (e) => e.key === "Enter" && $("login-btn").click());
$("setup-password").addEventListener("keydown", (e) => e.key === "Enter" && $("setup-btn").click());

$("logout-btn").onclick = () => {
  state.token = "";
  localStorage.removeItem("token");
  location.reload();
};

async function loadAll() {
  await Promise.all([loadSessions(), loadProviders(), loadModels(), loadSkills()]);
}

async function loadSkills() {
  const sel = $("skill-select");
  const keep = sel.value;
  sel.innerHTML = '<option value="">No skill</option>';
  try {
    const skills = await json(await api("/api/skills"));
    for (const s of skills) {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.title;
      o.title = s.description || "";
      sel.appendChild(o);
    }
  } catch { /* skills are optional */ }
  sel.value = keep;
}

async function loadModels() {
  const m = await json(await api("/api/models"));
  document.title = "JARVIS";
}

/* ---------------- sessions ---------------- */

async function loadSessions() {
  state.sessions = await json(await api("/api/sessions"));
  renderSessions();
}

function renderSessions() {
  const list = $("session-list");
  list.innerHTML = "";
  for (const s of state.sessions) {
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === state.sessionId ? " active" : "");
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = s.title || "Untitled";
    item.appendChild(title);
    item.onclick = () => selectSession(s.id);
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete session";
    del.onclick = async (e) => {
      e.stopPropagation();
      await api("/api/sessions/" + s.id, { method: "DELETE" });
      if (state.sessionId === s.id) { state.sessionId = null; renderChat(null); }
      await loadSessions();
    };
    item.appendChild(del);
    list.appendChild(item);
  }
}

async function newSession() {
  const s = await json(await api("/api/sessions", { method: "POST" }));
  state.sessionId = s.id;
  localStorage.setItem("session", s.id);
  await loadSessions();
  applyModelPrefFor(s.id);
  renderChat([]);
  $("input").focus();
}

async function selectSession(id) {
  state.sessionId = id;
  localStorage.setItem("session", id);
  const msgs = await json(await api(`/api/sessions/${id}/messages`));
  applyModelPrefFor(id);
  renderChat(msgs);
  renderSessions();
}

$("new-chat-btn").onclick = newSession;

/* ---------------- chat rendering ---------------- */

const chatEl = $("chat");

function renderChat(msgs) {
  const inner = document.createElement("div");
  inner.className = "chat-inner";
  if (!msgs || msgs.length === 0) {
    inner.innerHTML =
      '<div class="empty-chat">' +
      '<div class="logo">🤖</div>' +
      '<h2>JARVIS</h2>' +
      '<p>Ask it to build something, fix a bug, or browse the web.<br>It has file, shell and web tools in a safe workspace.</p>' +
      '<div class="chips">' +
      chips.map((c) => `<button class="chip">${esc(c)}</button>`).join("") +
      "</div></div>";
    for (const chip of inner.querySelectorAll(".chip")) {
      chip.onclick = () => { $("input").value = chip.textContent; $("input").focus(); };
    }
  } else {
    for (const m of msgs) {
      const div = document.createElement("div");
      div.className = "msg " + (m.role === "user" ? "user" : "assistant");
      div.innerHTML = `<div class="meta">${m.role === "user" ? "you" : "agent"}</div><div class="body">${
        m.role === "user" ? esc(m.content) : renderMarkdown(m.content)
      }</div>`;
      inner.appendChild(div);
    }
  }
  chatEl.innerHTML = "";
  chatEl.appendChild(inner);
  chatEl.scrollTop = chatEl.scrollHeight;
  wireCopyBtns();
}

function wireCopyBtns() {
  for (const b of document.querySelectorAll(".copy-btn")) {
    if (b.dataset.wired) continue;
    b.dataset.wired = "1";
    b.onclick = async () => {
      const pre = b.closest("pre");
      const txt = pre.textContent.replace(/^copy/, "").trim();
      await navigator.clipboard.writeText(txt);
      b.textContent = "copied!";
      setTimeout(() => (b.textContent = "copy"), 1200);
    };
  }
}

function appendMsg(role) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  const body = document.createElement("div");
  body.className = "body";
  div.appendChild(Object.assign(document.createElement("div"), { className: "meta", textContent: role === "user" ? "you" : "agent" }));
  div.appendChild(body);
  const activity = document.createElement("div");
  activity.className = "activity hidden";
  div.appendChild(activity);
  chatEl.querySelector(".chat-inner").appendChild(div);
  scrollChat();
  return { div, body, activity };
}

/* compact "working" indicator + collapsible tool log (hidden by default) */
function fmtArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try { return JSON.stringify(args, null, 1); } catch { return String(args); }
}
function makeActivity(activity) {
  const pill = document.createElement("div");
  pill.className = "act-pill";
  pill.innerHTML = '<span class="spin">⚙</span><span class="txt">working…</span>';
  activity.appendChild(pill);
  activity.classList.remove("hidden");

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "details-toggle hidden";
  toggleBtn.textContent = "⚙ expand tool details";
  toggleBtn.title = "Show/hide what tools ran and what commands they executed";
  activity.appendChild(toggleBtn);

  const toolbar = document.createElement("details");
  toolbar.className = "toolbar";
  toolbar.hidden = true;
  const summary = document.createElement("summary");
  toolbar.appendChild(summary);
  const list = document.createElement("div");
  list.className = "tool-list";
  toolbar.appendChild(list);
  activity.appendChild(toolbar);
  let rows = [];

  function refreshToggle() {
    const open = rows.every((r) => r.row.classList.contains("details-open"));
    toggleBtn.textContent = open && rows.length ? "⚙ collapse tool details" : "⚙ expand tool details";
  }
  toggleBtn.onclick = () => {
    rows.forEach((r) => r.row.classList.toggle("details-open"));
    refreshToggle();
  };

  return {
    status: (txt) => {
      if (toolbar.hidden) {
        pill.hidden = false;
        pill.querySelector(".txt").textContent = txt;
      }
    },
    dismiss: () => pill.hidden = true,
    addTool: (name, args) => {
      pill.hidden = false;
      pill.querySelector(".txt").textContent = "running " + name + "…";
      const row = document.createElement("div");
      row.className = "tool-row";
      const argText = fmtArgs(args);
      row.innerHTML =
        `<span class="tname">⚙ ${esc(name)}</span><span class="running">…</span>` +
        `<div class="tool-details">` +
        (argText ? `<div class="d-label">input</div><pre>${esc(argText)}</pre>` : "") +
        `<div class="d-label">result</div><pre class="t-result">…</pre>` +
        `</div>`;
      row.onclick = () => {
        row.classList.toggle("details-open");
        refreshToggle();
      };
      list.appendChild(row);
      rows.push({ row, result: row.querySelector(".t-result") });
      toolbar.hidden = false;
      toolbar.open = false;
      toggleBtn.classList.remove("hidden");
      refreshToggle();
    },
    toolDone: (name, ok, result) => {
      const r = rows[rows.length - 1];
      if (r) {
        const s = r.row.querySelector(".running");
        s.textContent = ok ? "done" : "error";
        s.className = ok ? "tstatus ok" : "tstatus err";
        const res = String(result ?? "");
        r.result.textContent = res.length > 600 ? res.slice(0, 600) + "\n…(truncated)" : res;
        r.row.querySelector(".tname").textContent = (ok ? "✓" : "✕") + " " + name;
      }
      pill.hidden = true;
    },
    finish: () => {
      pill.hidden = true;
      toolbar.hidden = false;
      toolbar.open = false;
      const c = rows.length;
      summary.innerHTML = `⚙ ${c} tool call${c === 1 ? "" : "s"} <span class="hint">— tap title, or the button above, to view inputs/outputs (commands that ran)</span>`;
      refreshToggle();
    },
    rows,
  };
}

function scrollChat() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

/* ---------------- sending ---------------- */

async function send() {
  const input = $("input");
  const text = input.value.trim();
  const attachments = state.pendingFiles.slice();
  if ((!text && !attachments.length) || !state.sessionId || state.busy) return;
  state.busy = true;
  $("send-btn").disabled = true;

  // WhatsApp-style: upload attached files to attachments/<session>/
  let attachedPaths = [];
  if (attachments.length) {
    const fd = new FormData();
    fd.append("path", "attachments/" + state.sessionId);
    for (const a of attachments) fd.append("file", a.file, a.name);
    try {
      const ur = await api("/api/files/upload", { method: "POST", body: fd });
      const uj = await ur.json().catch(() => ({}));
      if (!ur.ok) throw new Error(uj.detail || "upload failed");
      attachedPaths = uj.files || [];
    } catch (e) {
      state.pendingFiles = attachments;
      renderAttachBar();
      $("attach-bar").appendChild(Object.assign(document.createElement("span"), {
        className: "att-err muted small", textContent: "upload failed: " + e.message,
      }));
      state.busy = false;
      $("send-btn").disabled = false;
      return;
    }
  }

  const userDiv = appendMsg("user");
  userDiv.body.textContent = text || "📎 attached " + attachments.length + " file(s)";
  if (attachedPaths.length) {
    const chips = document.createElement("div");
    chips.className = "att-chips";
    chips.innerHTML = attachedPaths.map((p) => {
      const name = p.split("/").pop();
      return `<a class="att-chip" href="/api/files/download?path=${encodeURIComponent(p)}" download title="${esc(p)}">${esc(name)}</a>`;
    }).join("");
    userDiv.div.appendChild(chips);
  }
  input.value = "";
  input.style.height = "auto";
  state.pendingFiles = [];
  renderAttachBar();
  scrollChat();

  const userText = text || "Attached " + attachments.length + " file(s) — look at them and help me.";
  const { body: asBody, activity: asActivity } = appendMsg("assistant");
  uiState.activity = makeActivity(asActivity);
  uiState.answer = "";
  uiState.toolCount = 0;

  const ctrl = new AbortController();
  state.ctrl = ctrl;
  $("send-btn").textContent = "⏹";
  $("send-btn").classList.add("stopping");

  try {
    const r = await api("/api/chat", {
      method: "POST",
      signal: ctrl.signal,
      body: {
        session_id: state.sessionId,
        message: userText,
        provider_id: modelProviderId(),
        model: modelId(),
        skill: $("skill-select").value || null,
        attachments: attachedPaths,
      },
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || "chat failed");
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        let ev;
        try { ev = JSON.parse(dataLine.slice(6)); } catch { continue; }
        handleEvent(ev, asBody);
      }
    }
  } catch (e) {
    if (ctrl.signal.aborted) {
      asBody.innerHTML = `<span class="error">⏹ Stopped by you.</span>`;
      uiState.activity && uiState.activity.finish && uiState.activity.finish();
    } else {
      asBody.innerHTML = `<span class="error">Error: ${esc(e.message)}</span>`;
    }
  } finally {
    state.busy = false;
    state.ctrl = null;
    $("send-btn").textContent = "↑";
    $("send-btn").classList.remove("stopping");
    $("send-btn").disabled = false;
    $("input").focus();
  }
}

$("send-btn").onclick = () => { if (state.busy && state.ctrl) { state.ctrl.abort(); state.ctrl = null; } else { send(); } };

function handleEvent(ev, asBody) {
  const a = uiState.activity;
  switch (ev.type) {
    case "status":
      a.status(ev.message);
      break;
    case "text":
      a.dismiss();
      uiState.answer += ev.text;
      asBody.innerHTML = renderMarkdown(uiState.answer);
      scrollChat();
      break;
    case "tool_call":
      uiState.toolCount++;
      a.addTool(ev.name, ev.arguments);
      scrollChat();
      break;
    case "tool_result":
      a.toolDone(ev.name, !String(ev.result).startsWith("Error"), ev.result);
      break;
    case "done":
      a.finish();
      if (ev.content) {
        uiState.answer = ev.content;
        asBody.innerHTML = renderMarkdown(ev.content);
        Voice.speakReply(ev.content);
      }
      if (ev.files && ev.files.length) {
        const wrap = document.createElement("div");
        wrap.className = "out-files";
        wrap.innerHTML = '<span class="muted small">📎 Output files:</span>' +
          ev.files.map((p) => {
            const name = String(p).split("/").pop();
            return `<a class="att-chip" href="/api/files/download?path=${encodeURIComponent(p)}" download title="${esc(p)}">⬇ ${esc(name)}</a>`;
          }).join("");
        asBody.appendChild(wrap);
      }
      if (state.autoTitle) autoTitle();
      scrollChat();
      break;
    case "error":
      a.finish();
      asBody.innerHTML = `<span class="error">${esc(ev.message)}</span>`;
      Voice.speakReply("Error: " + ev.message);
      scrollChat();
      break;
  }
  wireCopyBtns();
}

async function autoTitle() {
  const sid = state.sessionId;
  const cur = state.sessions.find((s) => s.id === sid);
  if (!cur || (cur.title && cur.title !== "New chat")) return;
  const sent = document.querySelector(".msg.user .body");
  const title = (sent ? sent.textContent.trim().slice(0, 48) : "New chat") || "New chat";
  await api(`/api/sessions/${sid}/title`, { method: "POST", body: { title } });
  await loadSessions();
}

/* ---------------- provider / model selection ---------------- */

const chips = [
  "Create a simple to-do app in a single HTML file",
  "List the files in the workspace and summarize them",
  "Write a Python script that prints the first 10 Fibonacci numbers",
  "Search the web and summarize today's tech news",
];

function modelProviderId() {
  const parts = String(state.modelKey || "").split("|");
  return parts[0] || null;
}
function modelId() {
  const parts = String(state.modelKey || "").split("|");
  return parts[1] || null;
}

async function loadProviders() {
  try {
    state.providers = await json(await api("/api/providers"));
  } catch { state.providers = []; }
  const sel = $("model-select");
  sel.innerHTML = "";
  for (const p of state.providers) {
    if (!p.api_key_set && !p.local && !(p.base_url || "").startsWith("builtin:")) continue;
    const models = (Array.isArray(p.models) ? p.models : []).slice(0, 300);
    if (!models.length) continue;
    const og = document.createElement("optgroup");
    og.label = p.name + ((p.base_url || "").startsWith("builtin:") ? " (built-in)" : p.local ? " (local)" : "");
    for (const m of models) {
      const o = document.createElement("option");
      o.value = p.id + "|" + m;
      o.textContent = m;
      og.appendChild(o);
      if (!state.modelKey) state.modelKey = o.value;
    }
    sel.appendChild(og);
  }
  if (sel.options.length === 0) {
    const o = document.createElement("option");
    o.textContent = "no model provider configured (Settings → Models)";
    sel.appendChild(o);
  } else {
    let found = false;
    for (const o of sel.options) if (o.value === state.modelKey) found = true;
    if (!found) state.modelKey = sel.options[0].value;
    sel.value = state.modelKey;
  }
  sel.onchange = () => {
    state.modelKey = sel.value;
    localStorage.setItem("modelKey", sel.value);
    if (state.sessionId) {
      state.modelPrefs[state.sessionId] = sel.value;
      localStorage.setItem("modelPrefs", JSON.stringify(state.modelPrefs));
    }
  };
}

function applyModelPrefFor(sessionId) {
  const sel = $("model-select");
  const pref = state.modelPrefs[sessionId];
  const target = pref && [...sel.options].some((o) => o.value === pref) ? pref : state.modelKey;
  if (target && [...sel.options].some((o) => o.value === target)) {
    sel.value = target;
    state.modelKey = target;
  }
}

/* ---------------- composer ---------------- */

const input = $("input");
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 220) + "px";
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$("send-btn").onclick = send;
$("auto-title").checked = localStorage.getItem("autoTitle") !== "0";
$("auto-title").onchange = (e) => {
  state.autoTitle = e.target.checked;
  localStorage.setItem("autoTitle", e.target.checked ? "1" : "0");
};

/* ---- WhatsApp-style attachments ---- */

$("attach-btn").onclick = () => $("attach-input").click();
$("attach-input").onchange = () => {
  for (const f of $("attach-input").files) {
    state.pendingFiles.push({ name: f.name, file: f });
  }
  $("attach-input").value = "";
  renderAttachBar();
};

function renderAttachBar() {
  const bar = $("attach-bar");
  bar.innerHTML = "";
  if (!state.pendingFiles.length) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  for (let i = 0; i < state.pendingFiles.length; i++) {
    const chip = document.createElement("span");
    chip.className = "att-chip pending";
    chip.innerHTML = `📎 ${esc(state.pendingFiles[i].name)}`;
    const rm = document.createElement("button");
    rm.className = "att-rm";
    rm.textContent = "✕";
    rm.title = "Remove";
    rm.onclick = () => {
      state.pendingFiles.splice(i, 1);
      renderAttachBar();
    };
    chip.appendChild(rm);
    bar.appendChild(chip);
  }
}

/* ---- Voice chat: speak -> ".over" -> agent speaks -> "over" -> listen again ---- */

const Voice = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let on = false;
  let speaking = false;
  let processing = false;
  let buffer = [];
  let restartTimer = null;

  const statusEl = () => $("voice-status");
  const setStatus = (txt, cls) => {
    const el = statusEl();
    el.textContent = txt || "";
    el.className = "voice-status" + (cls ? " " + cls : "") + (!txt ? " hidden" : "");
  };

  function cancelAll() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (rec) { try { rec.onresult = null; rec.onerror = null; rec.onend = null; rec.stop(); } catch (e) {} rec = null; }
    if (speechSynthesis) speechSynthesis.cancel();
  }

  function startListening() {
    if (!on || speaking) return;
    if (!SR) { setStatus("voice unsupported in this browser", "on"); return; }
    try { rec = new SR(); } catch (e) { setStatus("voice unavailable", "on"); return; }
    rec.lang = $("voice-lang").value;
    rec.continuous = true;
    rec.interimResults = true;
    let lastInterim = "";
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = r[0].transcript.trim();
        if (r.isFinal) {
          buffer.push(t);
          const joined = buffer.join(" ").trim();
          const m = joined.match(/(?:^|\s)[.\s]*over\s*\.?\s*$/i);
          if (m) {
            processing = true;
            if (rec) { try { rec.stop(); } catch (e) {} }
            const withoutOver = joined.replace(/\s*\.\s*over\s*\.?\s*$/i, "").trim();
            buffer = [];
            if (withoutOver) sendVoice(withoutOver);
            else {
              processing = false;
              setStatus("Listening… say .over when done", "");
            }
            return;
          }
        } else {
          interim = t;
        }
      }
      const shown = buffer.join(" ") + (interim ? " " + interim : "");
      setStatus(shown ? `“${shown}”` : "Listening… say .over when done", "on");
      lastInterim = shown;
    };
    rec.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        setStatus("mic blocked — allow the browser mic permission", "on");
      } else if (ev.error === "no-speech") {
        // silent mic: keep it simple, restart shortly
      }
      if (on) restartListening(1200);
    };
    rec.onend = () => {
      if (on && !speaking && !processing) restartListening(300);
    };
    try { rec.start(); setStatus("Listening… say .over when done", "on"); } catch (e) {
      setStatus("could not start mic", "on");
    }
  }

  function restartListening(ms) {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(startListening, ms);
  }

  function sendVoice(text) {
    const input = $("input");
    input.value = text;
    send(); // existing send() runs the agent; on done we speak
  }

  function speak(text, then) {
    if (!on) { if (then) then(); return; }
    if (!("speechSynthesis" in window)) { if (then) then(); return; }
    speaking = true;
    const plain = String(text || "")
      .replace(/```[\s\S]*?```/g, " code block. ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/[*_#>\[\]()#|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const chunks = plain.match(/[\s\S]{1,180}(\s|$)/g) || [plain];
    const utter = (i) => {
      if (!on) { cancelAll(); speaking = false; if (then) then(); return; }
      if (!plain) { speechSay("over"); return; }
      if (i >= chunks.length) {
        speechSay("over");
        return;
      }
      const u = new SpeechSynthesisUtterance(chunks[i]);
      const pick = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith($("voice-lang").value.slice(0, 2)));
      if (pick) u.voice = pick;
      u.lang = $("voice-lang").value;
      u.rate = 1.02;
      u.onend = () => utter(i + 1);
      u.onerror = () => utter(i + 1);
      speechSynthesis.speak(u);
    };
    const speechSay = (word) => {
      const u = new SpeechSynthesisUtterance(word);
      const pick = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith($("voice-lang").value.slice(0, 2)));
      if (pick) u.voice = pick;
      u.lang = $("voice-lang").value;
      u.onend = () => { speaking = false; if (then) then(); };
      u.onerror = () => { speaking = false; if (then) then(); };
      speechSynthesis.speak(u);
    };
    utter(0);
  }

  return {
    get on() { return on; },
    toggle: () => {
      on = !on;
      $("voice-btn").classList.toggle("on", on);
      $("voice-lang").classList.toggle("hidden", !on);
      if (on) {
        buffer = [];
        setStatus("Listening… say .over when done", "on");
        startListening();
      } else {
        cancelAll();
        speaking = false;
        setStatus("", "");
      }
    },
    stop: () => { if (rec) { try { rec.stop(); } catch (e) {} } },
    restart: () => { if (on && !speaking) startListening(); },
    speakReply: (text) => {
      if (!on) return;
      processing = false;
      setStatus("Agent speaking… (mic off — playback noise is NOT recorded)", "speak");
      speak(text, () => {
        if (on) {
          setStatus("Listening… say .over when done", "on");
          startListening();
        }
      });
    },
  };
})();

$("voice-btn").onclick = () => Voice.toggle();
$("voice-lang").onchange = () => { if (Voice.on) { Voice.stop(); setTimeout(() => Voice.restart(), 250); } };

/* ---------------- settings modal ---------------- */

$("settings-btn").onclick = openSettings;
$("settings-close").onclick = () => { stopBotPoll(); $("settings-modal").classList.add("hidden"); };
document.querySelectorAll(".tab").forEach((t) =>
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    $("tab-" + t.dataset.tab).classList.remove("hidden");
    if (t.dataset.tab === "files") loadFileTree();
    if (t.dataset.tab === "bots") loadIntegrations();
  }
);

/* ---------------- integrations: Telegram + WhatsApp ---------------- */

let botPollTimer = null;

function stopBotPoll() {
  if (botPollTimer) { clearTimeout(botPollTimer); botPollTimer = null; }
}

function renderWhatsApp(wa) {
  const box = $("wa-qr-box");
  const img = $("wa-qr");
  const pairOut = $("wa-pair-out");
  if (wa.connected) {
    $("wa-status").textContent = "Connected" + (wa.user ? " as " + wa.user.replace(/:\d+$/, "") : "") + " — bot ready. Messages like .agent work now.";
    box.classList.add("hidden");
    pairOut.textContent = "";
  } else if (wa.qr) {
    img.src = wa.qr;
    box.classList.remove("hidden");
    $("wa-status").textContent = "Bridge running (" + (wa.state || "connecting") + "). Scan the QR with WhatsApp → Linked devices (refresh timer: 2s).";
  } else if (wa.bridge_up) {
    box.classList.add("hidden");
    $("wa-status").textContent = "Bridge up, waiting for QR… (" + (wa.state || "connecting") + ")";
  } else {
    box.classList.add("hidden");
    $("wa-status").textContent = "Bridge offline. Start it on the server: bash whatsapp/run.sh bridge";
  }
  if (wa.pairCode) {
    pairOut.textContent = "🔑 Pairing code: " + wa.pairCode + " — enter it in WhatsApp → Settings → Linked devices → Link with a phone number.";
  }
  if (wa.events && wa.events.length) {
    const log = $("wa-log");
    log.textContent = wa.events.join("\n");
  }
}

$("wa-pair-btn").onclick = async () => {
  const num = $("wa-number").value.trim();
  if (!/^\d{6,14}$/.test(num)) {
    $("wa-pair-out").textContent = "Enter the number with country code (digits only), e.g. 919876543210.";
    return;
  }
  $("wa-pair-out").textContent = "requesting pairing code…";
  const r = await api("/api/integrations/whatsapp/pair", {
    method: "POST",
    body: { number: num },
  }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok || j.ok !== true) {
    $("wa-pair-out").textContent = "error: " + (j.error || j.detail || "bridge offline") + " — start it with: bash whatsapp/run.sh bridge";
    return;
  }
  if (j.code) {
    $("wa-pair-out").textContent = "🔑 Pairing code: " + j.code + " — enter it in WhatsApp → Settings → Linked devices.";
  } else {
    $("wa-pair-out").textContent = j.message || "already logged in.";
  }
};

async function loadIntegrations() {
  try {
    const st = await json(await api("/api/integrations"));
    const tg = st.telegram || {};
    $("tg-enabled").checked = !!tg.enabled;
    const me = tg.me && tg.me.username ? "@" + tg.me.username : "";
    const bits = [];
    if (tg.running) bits.push(`● running${me ? " as " + me : ""}`);
    else if (tg.configured && tg.enabled) bits.push("○ token saved but not running (restart or save again)");
    else if (tg.configured) bits.push("○ token saved, bot disabled");
    else bits.push("○ not configured yet");
    if (tg.error) bits.push("⚠ " + tg.error);
    $("tg-status").textContent = "Status: " + bits.join(" · ");
    renderWhatsApp(st.whatsapp || {});
    stopBotPoll();
    botPollTimer = setTimeout(loadIntegrations, 2000);
  } catch (e) {
    $("tg-status").textContent = "Status: error loading — " + e.message;
    stopBotPoll();
    botPollTimer = setTimeout(loadIntegrations, 2000);
  }
}

$("tg-save").onclick = async () => {
  $("tg-status").textContent = "saving…";
  const r = await api("/api/integrations/telegram", {
    method: "POST",
    body: { token: $("tg-token").value.trim(), enabled: $("tg-enabled").checked },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("tg-status").textContent = "error: " + (j.detail || "failed"); return; }
  $("tg-token").value = "";
  if (j.error) { $("tg-status").textContent = "Status: " + j.error; return; }
  await loadIntegrations();
};

async function openSettings() {
  $("settings-modal").classList.remove("hidden");
  renderProviders();
  renderTokens();
  const health = await json(await fetch("/api/health"));
  $("ws-path").textContent = health.workspace;
  $("ws-path2").textContent = health.workspace;
  await loadFileTree();
}

function renderProviders() {
  const list = $("provider-list");
  list.innerHTML = "";
  for (const p of state.providers) {
    const item = document.createElement("div");
    item.className = "provider-item";
    const isBuiltin = (p.base_url || "").startsWith("builtin://");
    const badge = p.is_custom ? "" : `<span class="p-badge">built-in</span>`;
    item.innerHTML =
      `<div class="p-head"><span class="p-name">${esc(p.name)}</span>${badge}` +
      (p.local ? `<span class="p-badge">local</span>` : "") +
      (isBuiltin ? `<span class="p-badge">no key needed</span>` : `<span class="p-key">${p.api_key_set ? "✓ key set" : "no key"}</span>`) +
      `<span style="flex:1"></span></div>`;
    if (!isBuiltin) {
      item.innerHTML +=
        `<div class="api-key-row"><input type="password" placeholder="API key (free tier)" value="">` +
        `<button class="save-key">Set key</button>` +
        (p.is_custom ? `<button class="remove">Delete</button>` : "") + `</div>`;
    }
    if (p.hint) item.innerHTML += `<p class="p-hint">${esc(p.hint)}</p>`;
    const allModels = p.models || [];
    const models = allModels.slice(0, 40);
    const more = allModels.length > 40
      ? `<span class="model-pill">+${allModels.length - 40} more</span>`
      : "";
    item.innerHTML += `<div class="p-models">` +
      models.map((m) => `<span class="model-pill">${esc(m)}</span>`).join("") +
      more + `</div>`;
    if (!isBuiltin) {
      const keyInput = item.querySelector(".api-key-row input");
      item.querySelector(".save-key").onclick = async () => {
        const key = keyInput.value.trim();
        await api("/api/providers/" + p.id, {
          method: "PUT",
          body: { api_key: key, models },
        });
        keyInput.value = "";
        p.api_key_set = !!key;
        p.api_key = null;
        renderProviders();
        loadProviders();
      };
    }
    if (p.is_custom) {
      item.querySelector(".remove").onclick = async () => {
        await api("/api/providers/" + p.id, { method: "DELETE" });
        await loadAll();
        renderProviders();
      };
    }
    list.appendChild(item);
  }
}

const BMODEL_LIMIT = 40;
let lastProbe = [];

$("probe-btn").onclick = async () => {
  $("probe-out").textContent = "probing…";
  const r = await api("/api/providers/probe", {
    method: "POST",
    body: { base_url: $("p-url").value, api_key: $("p-key").value },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("probe-out").textContent = j.detail || "failed"; return; }
  lastProbe = j.models || [];
  if (lastProbe.length > BMODEL_LIMIT) {
    $("p-models").value = "";
    $("probe-out").textContent = `Connected. ${lastProbe.length} models found — will import them all (use the field to limit to specific ones).`;
  } else {
    $("p-models").value = lastProbe.join(",");
    $("probe-out").textContent = "Connected. Models found: " + lastProbe.length;
  }
};

$("add-provider-btn").onclick = async () => {
  const typed = $("p-models").value.split(",").map((s) => s.trim()).filter(Boolean);
  const models = typed.length ? typed : lastProbe;
  const r = await api("/api/providers", {
    method: "POST",
    body: {
      name: $("p-name").value || "Custom provider",
      base_url: $("p-url").value,
      api_key: $("p-key").value,
      models,
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("probe-out").textContent = j.detail || "failed"; return; }
  $("probe-out").textContent = `added (${models.length} models)`;
  lastProbe = [];
  $("p-name").value = ""; $("p-url").value = ""; $("p-key").value = ""; $("p-models").value = "";
  await loadAll();
  renderProviders();
};

async function renderTokens() {
  const list = $("token-list");
  const tokens = await json(await api("/api/tokens"));
  list.innerHTML = "";
  for (const t of tokens) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${esc(t.name)}</span><code>token #${t.id}</code>`;
    const del = document.createElement("button");
    del.className = "ghost";
    del.textContent = "delete";
    del.onclick = async () => {
      await api("/api/tokens/" + t.id, { method: "DELETE" });
      renderTokens();
    };
    li.appendChild(del);
    list.appendChild(li);
  }
}

$("create-token-btn").onclick = async () => {
  const r = await api("/api/tokens", { method: "POST", body: { name: $("token-name").value } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return;
  const li = document.createElement("li");
  li.innerHTML = `<span>${esc(j.name)}</span><code>${esc(j.token)}</code><button class="copy-token">copy</button>`;
  li.querySelector(".copy-token").onclick = () => navigator.clipboard.writeText(j.token);
  $("token-list").prepend(li);
  $("token-name").value = "";
};

$("change-pass-btn").onclick = async () => {
  const r = await api("/api/auth/change-password", { method: "POST", body: { password: $("new-pass").value } });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { $("new-pass").value = ""; alert("Password changed."); }
  else alert(j.detail || "failed");
};

/* ---------------- file browser ---------------- */

let fileTreeLoaded = false;
let fileDir = ""; // currently selected directory in the file browser

async function loadFileTree(force) {
  if (!force && fileTreeLoaded) return;
  fileTreeLoaded = true;
  const tree = $("file-tree");
  tree.innerHTML = "";
  await renderDir(tree, "", 0);
}

async function renderDir(container, path, depth) {
  const r = await api("/api/files?path=" + encodeURIComponent(path));
  if (!r.ok) return;
  const data = await r.json();
  for (const e of data.entries) {
    const node = document.createElement("div");
    node.className = "file-node " + (e.type === "dir" ? "dir" : "file");
    node.dataset.path = e.path || fileDir;
    const icon = e.type === "dir" ? "📁" : "📄";
    if (e.type === "file") {
      node.innerHTML =
        `<span class="indent" style="width:${depth * 14}px"></span><span class="f-icon">${icon}</span><span class="f-name">${esc(e.name)}</span>` +
        `<span class="f-size muted small">${e.size != null ? fmtSize(e.size) : ""}</span>` +
        `<a class="f-download" title="Download" href="/api/files/download?path=${encodeURIComponent(e.path)}" download>⬇</a>`;
      node.querySelector(".f-download").onclick = (ev) => ev.stopPropagation();
    } else {
      node.innerHTML = `<span class="indent" style="width:${depth * 14}px"></span><span class="f-icon">${icon}</span><span class="f-name">${esc(e.name)}</span>`;
    }
    node.onclick = async () => {
      document.querySelectorAll(".file-node").forEach((n) => n.classList.remove("selected"));
      node.classList.add("selected");
      if (e.type === "dir") {
        fileDir = e.path || "";
        const sub = document.createElement("div");
        if (!node.nextElementSibling) { container.insertBefore(sub, node.nextSibling); }
        else if (node.nextElementSibling.dataset.sub) { node.nextElementSibling.remove(); return; }
        sub.dataset.sub = "1";
        await renderDir(sub, e.path, depth + 1);
      } else {
        const fr = await api("/api/files/content?path=" + encodeURIComponent(e.path));
        const fj = await fr.json();
        $("file-path").textContent = e.path;
        $("file-save").classList.remove("hidden");
        $("file-save").dataset.path = e.path;
        $("file-download").classList.remove("hidden");
        $("file-download").dataset.path = e.path;
        $("file-content").value = fj.content || "";
      }
    };
    container.appendChild(node);
  }
}

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

$("file-save").onclick = async () => {
  await api("/api/files/write", {
    method: "POST",
    body: { path: $("file-save").dataset.path, content: $("file-content").value },
  });
  $("file-save").textContent = "Saved ✓";
  setTimeout(() => ($("file-save").textContent = "Save file"), 1200);
};

$("file-download").onclick = () => {
  if ($("file-download").dataset.path) {
    window.location.href = "/api/files/download?path=" + encodeURIComponent($("file-download").dataset.path);
  }
};

$("file-upload-btn").onclick = async () => {
  const input = $("file-upload");
  const files = input.files;
  if (!files.length) { $("upload-out").textContent = "choose file(s) first"; return; }
  $("upload-out").textContent = "uploading…";
  const fd = new FormData();
  fd.append("path", fileDir || "");
  for (const f of files) fd.append("file", f, f.name);
  try {
    const r = await fetch("/api/files/upload", {
      method: "POST",
      headers: { Authorization: "Bearer " + state.token },
      body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || "upload failed");
    $("upload-out").textContent = j.ok;
    input.value = "";
    fileTreeLoaded = false;
    await loadFileTree(true);
  } catch (e) {
    $("upload-out").textContent = "Error: " + e.message;
  }
};

/* ---------------- boot ---------------- */

(async function init() {
  document.title = "JARVIS";
  const saved = localStorage.getItem("session");
  await boot();
  if (state.token) {
    if (saved && state.sessions.some((s) => s.id === saved)) await selectSession(saved);
    else await newSession();
  }
})();