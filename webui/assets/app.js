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
  projects: [],
  jobs: [],
  busy: false,
  autoTitle: true,
  modelKey: localStorage.getItem("modelKey") || "",
  modelPrefs: JSON.parse(localStorage.getItem("modelPrefs") || "{}"),
  abort: null,
  ctrl: null,
  jobId: null,
  detached: false,
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

async function enterApp() {
  await loadAll();
  showScreen("app");
  const saved = localStorage.getItem("session");
  if (saved && state.sessions.some((s) => s.id === saved)) await selectSession(saved);
  else await newSession();
}

$("setup-btn").onclick = async () => {
  const r = await api("/api/auth/setup", { method: "POST", body: { password: $("setup-password").value } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("setup-error").textContent = j.detail || "failed"; return; }
  state.token = j.token;
  localStorage.setItem("token", j.token);
  await enterApp();
};

$("login-btn").onclick = async () => {
  const r = await api("/api/auth/login", { method: "POST", body: { password: $("login-password").value } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("login-error").textContent = j.detail || "failed"; return; }
  state.token = j.token;
  localStorage.setItem("token", j.token);
  await enterApp();
};
$("login-password").addEventListener("keydown", (e) => e.key === "Enter" && $("login-btn").click());
$("setup-password").addEventListener("keydown", (e) => e.key === "Enter" && $("setup-btn").click());

$("logout-btn").onclick = () => {
  state.token = "";
  localStorage.removeItem("token");
  location.reload();
};

async function loadAll() {
  await Promise.all([loadSessions(), loadProviders(), loadModels(), loadSkills(), loadProjects(), loadJobs()]);
}

async function loadProjects() {
  const sel = $("project-select");
  const keep = sel.value;
  sel.innerHTML = '<option value="">No project</option>';
  try {
    state.projects = await json(await api("/api/projects"));
    for (const p of state.projects) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = "📁 " + p.name;
      sel.appendChild(o);
    }
  } catch { state.projects = []; }
  sel.value = keep;
}

$("project-select").onchange = async () => {
  if (!state.sessionId) return;
  await api(`/api/sessions/${state.sessionId}/project`, {
    method: "POST",
    body: { project_id: $("project-select").value || null },
  });
  await loadSessions();
};

async function loadJobs() {
  try {
    state.jobs = await json(await api("/api/jobs"));
  } catch { state.jobs = []; }
  renderSessions();
  updateBanner();
}

function runningJobFor(sessionId) {
  return state.jobs.find((j) => j.session_id === sessionId && j.status === "running") || null;
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
    if (runningJobFor(s.id)) {
      const dot = document.createElement("span");
      dot.className = "run-dot";
      dot.title = "Working in background";
      item.appendChild(dot);
    }
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
      await loadJobs();
    };
    item.appendChild(del);
    list.appendChild(item);
  }
}

async function newSession() {
  const s = await json(await api("/api/sessions", {
    method: "POST",
    body: { project_id: $("project-select").value || null },
  }));
  state.sessionId = s.id;
  localStorage.setItem("session", s.id);
  await loadSessions();
  applyModelPrefFor(s.id);
  renderChat([]);
  updateBanner();
  $("input").focus();
}

async function selectSession(id) {
  if (state.busy && state.jobId && state.sessionId !== id) pushToBackground(true);
  state.sessionId = id;
  localStorage.setItem("session", id);
  const msgs = await json(await api(`/api/sessions/${id}/messages`));
  const sess = state.sessions.find((s) => s.id === id);
  $("project-select").value = (sess && sess.project_id) || "";
  applyModelPrefFor(id);
  renderChat(msgs);
  renderSessions();
  await loadJobs();
  const job = runningJobFor(id);
  if (job && !state.busy) await resumeJob(job.id);
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

/* modern collapsible "thinking / process" block, like other agent apps */
function fmtArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try { return JSON.stringify(args, null, 1); } catch { return String(args); }
}
function makeActivity(activity) {
  const started = Date.now();
  activity.classList.remove("hidden");
  activity.classList.add("activity");

  const head = document.createElement("button");
  head.className = "act-head";
  head.type = "button";
  head.innerHTML =
    '<span class="act-status"><span class="act-ico spin">◐</span><span class="act-txt">Thinking…</span></span>' +
    '<span class="act-count"></span><span class="act-chev">▸</span>';
  activity.appendChild(head);

  const panel = document.createElement("div");
  panel.className = "act-panel";
  const list = document.createElement("div");
  list.className = "tool-list";
  panel.appendChild(list);
  activity.appendChild(panel);

  head.onclick = () => activity.classList.toggle("open");

  const txt = head.querySelector(".act-txt");
  const ico = head.querySelector(".act-ico");
  const count = head.querySelector(".act-count");
  let rows = [];
  let finished = false;

  function refreshCount() {
    count.textContent = rows.length ? `${rows.length} tool${rows.length === 1 ? "" : "s"}` : "";
    head.classList.toggle("has-tools", rows.length > 0);
  }

  return {
    status: (m) => { if (!finished) txt.textContent = m; },
    dismiss: () => { if (!finished) { txt.textContent = "Writing answer…"; ico.classList.remove("spin"); ico.textContent = "✎"; } },
    addTool: (name, args) => {
      if (!finished) { ico.classList.add("spin"); ico.textContent = "◐"; txt.textContent = "Running " + name + "…"; }
      const row = document.createElement("div");
      row.className = "tool-row";
      const argText = fmtArgs(args);
      row.innerHTML =
        `<span class="tname">⚙ ${esc(name)}</span><span class="running">…</span>` +
        `<div class="tool-details">` +
        (argText ? `<div class="d-label">input</div><pre>${esc(argText)}</pre>` : "") +
        `<div class="d-label">result</div><pre class="t-result">…</pre>` +
        `</div>`;
      row.onclick = () => row.classList.toggle("details-open");
      list.appendChild(row);
      rows.push({ row, result: row.querySelector(".t-result") });
      refreshCount();
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
    },
    finish: () => {
      finished = true;
      const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
      ico.classList.remove("spin");
      ico.textContent = "✓";
      head.classList.add("done");
      txt.textContent = rows.length
        ? `Worked for ${secs}s · ${rows.length} tool call${rows.length === 1 ? "" : "s"}`
        : "Done";
      refreshCount();
      count.textContent = "";
    },
    fail: () => {
      finished = true;
      ico.classList.remove("spin");
      ico.textContent = "✕";
      head.classList.add("done", "failed");
      txt.textContent = "Stopped";
    },
    rows,
  };
}

function scrollChat() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

/* ---------------- sending + background jobs ---------------- */

function setBusyUI(busy) {
  state.busy = busy;
  $("send-btn").textContent = busy ? "⏹" : "↑";
  $("send-btn").classList.toggle("stopping", busy);
  $("send-btn").title = busy ? "Stop the task" : "Send message";
  $("push-btn").classList.toggle("hidden", !busy);
}

function updateBanner() {
  const banner = $("bg-banner");
  const job = state.sessionId ? runningJobFor(state.sessionId) : null;
  if (job && !state.busy) {
    banner.dataset.job = job.id;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function pushToBackground() {
  if (!state.busy || !state.ctrl) return;
  state.detached = true;
  state.ctrl.abort();
}

$("push-btn").onclick = pushToBackground;
$("bg-resume").onclick = () => {
  const id = $("bg-banner").dataset.job;
  if (id) resumeJob(id);
};
$("bg-stop").onclick = async () => {
  const id = $("bg-banner").dataset.job;
  if (!id) return;
  await api(`/api/jobs/${id}/stop`, { method: "POST" }).catch(() => {});
  await loadJobs();
};

async function readSSE(r, asBody) {
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
}

function detachedNote(asBody) {
  const note = document.createElement("div");
  note.className = "bg-note muted small";
  note.textContent = "⤓ Continuing in the background — you can close this window. Resume from the banner above the input box.";
  asBody.appendChild(note);
  if (uiState.activity) uiState.activity.status("Working in background…");
}

async function send() {
  const input = $("input");
  const text = input.value.trim();
  const attachments = state.pendingFiles.slice();
  if ((!text && !attachments.length) || !state.sessionId || state.busy) return;
  if (runningJobFor(state.sessionId)) {
    alert("A task is already running in this chat — resume it from the banner, or stop it first.");
    return;
  }
  setBusyUI(true);
  state.detached = false;
  state.jobId = null;

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
      setBusyUI(false);
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
    await readSSE(r, asBody);
  } catch (e) {
    if (ctrl.signal.aborted && state.detached) {
      detachedNote(asBody);
    } else if (ctrl.signal.aborted) {
      asBody.innerHTML = `<span class="error">⏹ Stopped.</span>`;
      if (uiState.activity) uiState.activity.fail();
    } else {
      asBody.innerHTML = `<span class="error">Error: ${esc(e.message)}</span>`;
      if (uiState.activity) uiState.activity.fail();
    }
  } finally {
    state.ctrl = null;
    setBusyUI(false);
    if (!state.detached) { state.jobId = null; $("input").focus(); }
    loadJobs();
  }
}

async function resumeJob(jobId) {
  if (state.busy) return;
  const job = state.jobs.find((j) => j.id === jobId);
  const sid = job ? job.session_id : state.sessionId;
  if (!sid) return;
  if (sid !== state.sessionId) {
    state.sessionId = sid;
    localStorage.setItem("session", sid);
    const sess = state.sessions.find((s) => s.id === sid);
    $("project-select").value = (sess && sess.project_id) || "";
    applyModelPrefFor(sid);
    renderSessions();
  }
  try {
    state.jobs = await json(await api("/api/jobs"));
  } catch { /* keep cached list */ }
  const fresh = state.jobs.find((j) => j.id === jobId);
  const msgs = await json(await api(`/api/sessions/${sid}/messages`));
  renderChat(msgs);
  if (!fresh || fresh.status !== "running") {
    updateBanner();
    return;
  }
  setBusyUI(true);
  state.detached = false;
  state.jobId = jobId;
  updateBanner();

  const { body: asBody, activity: asActivity } = appendMsg("assistant");
  uiState.activity = makeActivity(asActivity);
  uiState.answer = "";
  uiState.toolCount = 0;

  const ctrl = new AbortController();
  state.ctrl = ctrl;
  try {
    const r = await api(`/api/jobs/${jobId}/stream?after=0`, { signal: ctrl.signal });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || "cannot resume this task");
    }
    await readSSE(r, asBody);
  } catch (e) {
    if (ctrl.signal.aborted && state.detached) {
      detachedNote(asBody);
    } else if (!ctrl.signal.aborted) {
      asBody.innerHTML = `<span class="error">Error: ${esc(e.message)}</span>`;
      if (uiState.activity) uiState.activity.fail();
    }
  } finally {
    state.ctrl = null;
    setBusyUI(false);
    if (!state.detached) state.jobId = null;
    loadJobs();
  }
}

$("send-btn").onclick = async () => {
  if (state.busy) {
    if (state.jobId) {
      await api(`/api/jobs/${state.jobId}/stop`, { method: "POST" }).catch(() => {});
    } else if (state.ctrl) {
      state.ctrl.abort();
    }
  } else {
    send();
  }
};

function handleEvent(ev, asBody) {
  const a = uiState.activity;
  switch (ev.type) {
    case "job":
      state.jobId = ev.id;
      break;
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
      if (ev.stopped) a.fail(); else a.finish();
      if (ev.content) {
        uiState.answer = ev.content;
        asBody.innerHTML = renderMarkdown(ev.content);
        if (!ev.stopped) Voice.speakReply(ev.content);
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
      if (state.autoTitle && !ev.stopped) autoTitle();
      scrollChat();
      break;
    case "error":
      a.fail();
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
$("auto-title").checked = localStorage.getItem("autoTitle") !== "0";
$("auto-title").onchange = (e) => {
  state.autoTitle = e.target.checked;
  localStorage.setItem("autoTitle", e.target.checked ? "1" : "0");
};

/* ---- thinking / tool log visibility switches ---- */

function applyLogToggles() {
  const think = localStorage.getItem("showThinking") !== "0";
  const toollog = localStorage.getItem("showToolLog") !== "0";
  $("toggle-thinking").checked = think;
  $("toggle-toollog").checked = toollog;
  document.body.classList.toggle("hide-thinking", !think);
  document.body.classList.toggle("hide-toollog", !toollog);
}
$("toggle-thinking").onchange = (e) => {
  localStorage.setItem("showThinking", e.target.checked ? "1" : "0");
  applyLogToggles();
};
$("toggle-toollog").onchange = (e) => {
  localStorage.setItem("showToolLog", e.target.checked ? "1" : "0");
  applyLogToggles();
};
applyLogToggles();

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
    if (t.dataset.tab === "mcp") loadMcpTab();
    if (t.dataset.tab === "skills") loadSkillsTab();
    if (t.dataset.tab === "projects") loadProjectsTab();
    if (t.dataset.tab === "appearance") renderAppearance();
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

/* ---------------- MCP servers tab ---------------- */

let mcpPresets = [];

function splitArgs(text) {
  return (String(text || "").match(/"[^"]*"|\S+/g) || []).map((s) => s.replace(/^"|"$/g, ""));
}

function parseEnvText(text) {
  const env = {};
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

function mcpFormBody() {
  return {
    name: $("mcp-name").value.trim(),
    command: $("mcp-command").value.trim(),
    args: splitArgs($("mcp-args").value),
    env: parseEnvText($("mcp-env").value),
  };
}

async function loadMcpTab() {
  const data = await json(await api("/api/mcp"));
  mcpPresets = data.presets || [];
  const grid = $("mcp-presets");
  grid.innerHTML = "";
  for (const p of mcpPresets) {
    const card = document.createElement("div");
    card.className = "preset-card";
    card.innerHTML =
      `<div class="preset-name">${esc(p.name)}</div>` +
      `<p class="muted small">${esc(p.description)}</p>` +
      `<code class="preset-cmd">${esc(p.command + " " + (p.args || []).join(" "))}</code>`;
    const btn = document.createElement("button");
    btn.textContent = "+ Add";
    btn.onclick = () => {
      $("mcp-custom").open = true;
      $("mcp-name").value = p.name;
      $("mcp-command").value = p.command;
      $("mcp-args").value = (p.args || []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
      $("mcp-env").value = Object.entries(p.env || {}).map(([k, v]) => `${k}=${v}`).join("\n");
      $("mcp-out").textContent = (p.needs_env && p.needs_env.length)
        ? "Fill in " + p.needs_env.join(", ") + " above, then click Add server."
        : "Ready — click Add server.";
      $("mcp-custom").scrollIntoView({ behavior: "smooth", block: "center" });
    };
    card.appendChild(btn);
    grid.appendChild(card);
  }
  renderMcpServers(data.servers || []);
}

function renderMcpServers(servers) {
  const list = $("mcp-list");
  list.innerHTML = servers.length ? "" : '<p class="muted small">No MCP servers yet — add a preset above or a custom command below.</p>';
  for (const s of servers) {
    const item = document.createElement("div");
    item.className = "provider-item";
    item.innerHTML =
      `<div class="p-head"><span class="p-name">${esc(s.name)}</span><span class="p-badge">${esc(s.command)}</span><span style="flex:1"></span></div>` +
      `<p class="p-hint mono">${esc(s.command + " " + (s.args || []).join(" "))}</p>` +
      `<div class="row mcp-actions"></div><p class="muted small mcp-out"></p>`;
    const actions = item.querySelector(".mcp-actions");
    const enable = document.createElement("label");
    enable.className = "hint";
    enable.innerHTML = `<input type="checkbox" ${s.enabled ? "checked" : ""}> enabled`;
    enable.querySelector("input").onchange = async (e) => {
      await api("/api/mcp/" + s.id, { method: "PUT", body: { enabled: e.target.checked } });
    };
    const test = document.createElement("button");
    test.textContent = "Test";
    test.onclick = async () => {
      const out = item.querySelector(".mcp-out");
      out.textContent = "testing… (the first npx run downloads the package, give it a minute)";
      const r = await api(`/api/mcp/${s.id}/test`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      out.textContent = j.ok
        ? `✓ ${j.tools.length} tools: ` + j.tools.map((t) => t.name).slice(0, 12).join(", ")
        : "✕ " + (j.error || "failed");
    };
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "ghost danger-text";
    del.onclick = async () => {
      await api("/api/mcp/" + s.id, { method: "DELETE" });
      loadMcpTab();
    };
    actions.append(enable, test, del);
    list.appendChild(item);
  }
}

$("mcp-test-btn").onclick = async () => {
  const body = mcpFormBody();
  if (!body.name || !body.command) { $("mcp-out").textContent = "name and command required"; return; }
  $("mcp-out").textContent = "testing… (the first npx run downloads the package, give it a minute)";
  const r = await api("/api/mcp/test", { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  $("mcp-out").textContent = j.ok
    ? `✓ connected — ${j.tools.length} tools: ` + j.tools.map((t) => t.name).slice(0, 12).join(", ")
    : "✕ " + (j.error || j.detail || "failed");
};

$("mcp-add-btn").onclick = async () => {
  const body = mcpFormBody();
  if (!body.name || !body.command) { $("mcp-out").textContent = "name and command required"; return; }
  const r = await api("/api/mcp", { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("mcp-out").textContent = j.detail || "failed"; return; }
  $("mcp-out").textContent = "added ✓ — its tools are available in the next chat";
  $("mcp-name").value = ""; $("mcp-command").value = ""; $("mcp-args").value = ""; $("mcp-env").value = "";
  loadMcpTab();
};

/* ---------------- skills tab ---------------- */

let editingSkill = null;

async function loadSkillsTab() {
  const skills = await json(await api("/api/skills"));
  const list = $("skill-list");
  list.innerHTML = "";
  for (const s of skills) {
    const item = document.createElement("div");
    item.className = "provider-item";
    item.innerHTML =
      `<div class="p-head"><span class="p-name">${esc(s.title)}</span><span class="p-badge">${esc(s.id)}</span><span style="flex:1"></span></div>` +
      `<p class="p-hint">${esc(s.description || "")}</p>`;
    const row = document.createElement("div");
    row.className = "row";
    const edit = document.createElement("button");
    edit.textContent = "Edit";
    edit.onclick = async () => {
      const j = await json(await api("/api/skills/" + s.id));
      editingSkill = s.id;
      $("skill-id").value = s.id;
      $("skill-id").disabled = true;
      $("skill-content").value = j.content;
      $("skill-out").textContent = "";
      $("skill-editor").classList.remove("hidden");
      $("skill-editor").scrollIntoView({ behavior: "smooth", block: "center" });
    };
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "ghost danger-text";
    del.onclick = async () => {
      if (!confirm(`Delete skill "${s.title}"?`)) return;
      await api("/api/skills/" + s.id, { method: "DELETE" });
      loadSkillsTab();
      loadSkills();
    };
    row.append(edit, del);
    item.appendChild(row);
    list.appendChild(item);
  }
}

$("skill-new-btn").onclick = () => {
  editingSkill = null;
  $("skill-id").value = "";
  $("skill-id").disabled = false;
  $("skill-content").value = "";
  $("skill-out").textContent = "";
  $("skill-editor").classList.remove("hidden");
  $("skill-content").focus();
};
$("skill-cancel-btn").onclick = () => $("skill-editor").classList.add("hidden");

$("skill-save-btn").onclick = async () => {
  const content = $("skill-content").value.trim();
  if (!content) { $("skill-out").textContent = "write some content first"; return; }
  let r;
  if (editingSkill) {
    r = await api("/api/skills/" + editingSkill, { method: "PUT", body: { content } });
  } else {
    const titleM = content.match(/^#+\s+(.+)/m);
    r = await api("/api/skills", {
      method: "POST",
      body: { id: $("skill-id").value.trim(), title: titleM ? titleM[1] : "", content },
    });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("skill-out").textContent = j.detail || "failed"; return; }
  $("skill-editor").classList.add("hidden");
  loadSkillsTab();
  loadSkills();
};

$("skill-import").onchange = async () => {
  const files = [...$("skill-import").files];
  let ok = 0;
  const errs = [];
  for (const f of files) {
    const text = await f.text();
    const id = f.name.replace(/\.(md|txt)$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill";
    const r = await api("/api/skills", { method: "POST", body: { id, content: text } });
    if (r.ok) ok++;
    else {
      const j = await r.json().catch(() => ({}));
      errs.push(`${f.name}: ${j.detail || "failed"}`);
    }
  }
  $("skill-import").value = "";
  $("skill-import-out").textContent = `imported ${ok}/${files.length}` + (errs.length ? " — " + errs.join("; ") : "");
  loadSkillsTab();
  loadSkills();
};

/* ---------------- projects tab ---------------- */

let openProject = null;

async function loadProjectsTab() {
  const projects = await json(await api("/api/projects"));
  const list = $("proj-list");
  list.innerHTML = projects.length ? "" : '<p class="muted small">No projects yet. Create one, add knowledge, then pick it in the top bar.</p>';
  for (const p of projects) {
    const item = document.createElement("div");
    item.className = "provider-item";
    item.innerHTML =
      `<div class="p-head"><span class="p-name">📁 ${esc(p.name)}</span>` +
      `<span class="p-badge">${p.file_count} knowledge file${p.file_count === 1 ? "" : "s"}</span><span style="flex:1"></span></div>`;
    const row = document.createElement("div");
    row.className = "row";
    const open = document.createElement("button");
    open.textContent = "Open";
    open.onclick = () => openProjectDetail(p.id);
    row.appendChild(open);
    item.appendChild(row);
    list.appendChild(item);
  }
  loadProjects();
}

async function openProjectDetail(id) {
  const p = await json(await api("/api/projects/" + id));
  openProject = id;
  $("proj-detail").classList.remove("hidden");
  $("proj-edit-name").value = p.name;
  $("proj-instructions").value = p.instructions || "";
  $("proj-file-out").textContent = "";
  $("proj-paste-box").classList.add("hidden");
  renderProjectFiles(p.files || []);
  $("proj-detail").scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderProjectFiles(files) {
  const ul = $("proj-files");
  ul.innerHTML = files.length ? "" : '<li class="muted small">No knowledge files yet — upload docs/notes or paste text.</li>';
  for (const f of files) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="kf-name">📄 ${esc(f.name)}</span><span class="muted small">${fmtSize(f.size || 0)}</span>`;
    const view = document.createElement("button");
    view.textContent = "View";
    view.className = "ghost";
    view.onclick = async () => {
      const existing = li.querySelector("pre");
      if (existing) { existing.remove(); return; }
      const full = await json(await api(`/api/projects/${openProject}/files/${f.id}`));
      const pre = document.createElement("pre");
      pre.className = "kf-preview";
      pre.textContent = full.content;
      li.appendChild(pre);
    };
    const del = document.createElement("button");
    del.textContent = "✕";
    del.className = "ghost danger-text";
    del.title = "Remove";
    del.onclick = async () => {
      await api(`/api/projects/${openProject}/files/${f.id}`, { method: "DELETE" });
      openProjectDetail(openProject);
    };
    li.append(view, del);
    ul.appendChild(li);
  }
}

$("proj-create-btn").onclick = async () => {
  const name = $("proj-name").value.trim();
  if (!name) return;
  const r = await api("/api/projects", { method: "POST", body: { name } });
  if (!r.ok) return;
  $("proj-name").value = "";
  await loadProjectsTab();
  const p = await r.json().catch(() => ({}));
  if (p.id) openProjectDetail(p.id);
};

$("proj-save-btn").onclick = async () => {
  if (!openProject) return;
  await api("/api/projects/" + openProject, {
    method: "PUT",
    body: { name: $("proj-edit-name").value.trim(), instructions: $("proj-instructions").value },
  });
  $("proj-file-out").textContent = "saved ✓";
  loadProjectsTab();
};

$("proj-delete-btn").onclick = async () => {
  if (!openProject || !confirm("Delete this project and its knowledge files? Chats keep their history.")) return;
  await api("/api/projects/" + openProject, { method: "DELETE" });
  openProject = null;
  $("proj-detail").classList.add("hidden");
  loadProjectsTab();
};

$("proj-close-btn").onclick = () => {
  openProject = null;
  $("proj-detail").classList.add("hidden");
};

$("proj-file-input").onchange = async () => {
  if (!openProject) return;
  const files = [...$("proj-file-input").files];
  let ok = 0;
  const errs = [];
  for (const f of files) {
    const text = await f.text();
    const r = await api(`/api/projects/${openProject}/files`, { method: "POST", body: { name: f.name, content: text } });
    if (r.ok) ok++;
    else {
      const j = await r.json().catch(() => ({}));
      errs.push(`${f.name}: ${j.detail || "failed"}`);
    }
  }
  $("proj-file-input").value = "";
  $("proj-file-out").textContent = `added ${ok}/${files.length}` + (errs.length ? " — " + errs.join("; ") : "");
  openProjectDetail(openProject);
};

$("proj-paste-btn").onclick = () => $("proj-paste-box").classList.toggle("hidden");
$("proj-paste-save").onclick = async () => {
  if (!openProject) return;
  const name = $("proj-paste-name").value.trim();
  const content = $("proj-paste-content").value;
  if (!name || !content.trim()) { $("proj-file-out").textContent = "name and content required"; return; }
  const r = await api(`/api/projects/${openProject}/files`, { method: "POST", body: { name, content } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("proj-file-out").textContent = j.detail || "failed"; return; }
  $("proj-paste-name").value = "";
  $("proj-paste-content").value = "";
  $("proj-paste-box").classList.add("hidden");
  openProjectDetail(openProject);
};

/* ---------------- appearance / themes ---------------- */

const THEMES = {
  dark: {
    label: "Default Dark",
    vars: {
      "--bg": "#0d1117", "--bg2": "#161b22", "--bg3": "#1c2333", "--border": "#262f40",
      "--text": "#e6edf4", "--muted": "#8b96a8", "--accent": "#4f8cff", "--accent2": "#22c55e", "--accent3": "#a78bfa",
      "--glow-a": "rgba(79,140,255,.18)", "--glow-b": "rgba(167,139,250,.12)",
      "--surface-sidebar": "rgba(22,27,34,.7)", "--surface-topbar": "rgba(22,27,34,.5)", "--surface-card": "rgba(22,27,34,.9)",
      "--overlay": "rgba(0,0,0,.6)", "--row-tint": "rgba(255,255,255,.03)", "--code-bg": "rgba(0,0,0,.25)",
    },
  },
  midnight: {
    label: "Midnight",
    vars: {
      "--bg": "#05060f", "--bg2": "#0b0e1d", "--bg3": "#131735", "--border": "#232a52",
      "--text": "#e8eaff", "--muted": "#8f96c0", "--accent": "#7c5cff", "--accent2": "#34d399", "--accent3": "#38bdf8",
      "--glow-a": "rgba(124,92,255,.2)", "--glow-b": "rgba(56,189,248,.12)",
      "--surface-sidebar": "rgba(11,14,29,.75)", "--surface-topbar": "rgba(11,14,29,.55)", "--surface-card": "rgba(11,14,29,.92)",
      "--overlay": "rgba(0,0,0,.65)", "--row-tint": "rgba(255,255,255,.04)", "--code-bg": "rgba(0,0,0,.35)",
    },
  },
  light: {
    label: "Light",
    vars: {
      "--bg": "#f5f7fb", "--bg2": "#ffffff", "--bg3": "#eef1f7", "--border": "#d8dee9",
      "--text": "#1a2233", "--muted": "#5b6577", "--accent": "#2563eb", "--accent2": "#16a34a", "--accent3": "#7c3aed",
      "--glow-a": "rgba(37,99,235,.1)", "--glow-b": "rgba(124,58,237,.08)",
      "--surface-sidebar": "rgba(255,255,255,.8)", "--surface-topbar": "rgba(255,255,255,.65)", "--surface-card": "rgba(255,255,255,.95)",
      "--overlay": "rgba(15,23,42,.35)", "--row-tint": "rgba(15,23,42,.04)", "--code-bg": "rgba(15,23,42,.06)",
    },
  },
  ocean: {
    label: "Ocean",
    vars: {
      "--bg": "#04121d", "--bg2": "#082032", "--bg3": "#0d2c42", "--border": "#16405c",
      "--text": "#e2f3ff", "--muted": "#7fa8bf", "--accent": "#06b6d4", "--accent2": "#34d399", "--accent3": "#60a5fa",
      "--glow-a": "rgba(6,182,212,.16)", "--glow-b": "rgba(96,165,250,.12)",
      "--surface-sidebar": "rgba(8,32,50,.75)", "--surface-topbar": "rgba(8,32,50,.55)", "--surface-card": "rgba(8,32,50,.92)",
      "--overlay": "rgba(0,0,0,.6)", "--row-tint": "rgba(255,255,255,.04)", "--code-bg": "rgba(0,0,0,.3)",
    },
  },
  forest: {
    label: "Forest",
    vars: {
      "--bg": "#07130c", "--bg2": "#0d1f14", "--bg3": "#143020", "--border": "#1e4530",
      "--text": "#e7f5ec", "--muted": "#86a896", "--accent": "#22c55e", "--accent2": "#a3e635", "--accent3": "#fbbf24",
      "--glow-a": "rgba(34,197,94,.14)", "--glow-b": "rgba(163,230,53,.1)",
      "--surface-sidebar": "rgba(13,31,20,.75)", "--surface-topbar": "rgba(13,31,20,.55)", "--surface-card": "rgba(13,31,20,.92)",
      "--overlay": "rgba(0,0,0,.6)", "--row-tint": "rgba(255,255,255,.04)", "--code-bg": "rgba(0,0,0,.3)",
    },
  },
  sunset: {
    label: "Sunset",
    vars: {
      "--bg": "#170d12", "--bg2": "#22131c", "--bg3": "#301b28", "--border": "#47263a",
      "--text": "#fdeef4", "--muted": "#b58a9c", "--accent": "#fb7185", "--accent2": "#fbbf24", "--accent3": "#f472b6",
      "--glow-a": "rgba(251,113,133,.16)", "--glow-b": "rgba(244,114,182,.12)",
      "--surface-sidebar": "rgba(34,19,28,.75)", "--surface-topbar": "rgba(34,19,28,.55)", "--surface-card": "rgba(34,19,28,.92)",
      "--overlay": "rgba(0,0,0,.6)", "--row-tint": "rgba(255,255,255,.04)", "--code-bg": "rgba(0,0,0,.3)",
    },
  },
};

function applyTheme() {
  const name = localStorage.getItem("theme") || "dark";
  const t = THEMES[name] || THEMES.dark;
  const root = document.documentElement;
  root.dataset.theme = name;
  const vars = Object.assign({}, t.vars);
  const accent = localStorage.getItem("accent");
  if (accent) vars["--accent"] = accent;
  vars["--grad"] = `linear-gradient(135deg, ${vars["--accent"]} 0%, ${vars["--accent3"]} 50%, #ec4899 100%)`;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}

function renderAppearance() {
  const grid = $("theme-grid");
  grid.innerHTML = "";
  const current = localStorage.getItem("theme") || "dark";
  for (const [name, t] of Object.entries(THEMES)) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "theme-card" + (name === current ? " active" : "");
    card.innerHTML =
      `<span class="theme-swatch" style="background:${t.vars["--bg"]};border-color:${t.vars["--border"]}">` +
      `<span style="background:${t.vars["--bg2"]}"></span>` +
      `<span style="background:${t.vars["--accent"]}"></span>` +
      `<span style="background:${t.vars["--accent3"]}"></span></span>` +
      `<span class="theme-name">${esc(t.label)}</span>`;
    card.onclick = () => {
      localStorage.setItem("theme", name);
      applyTheme();
      renderAppearance();
    };
    grid.appendChild(card);
  }
  const t = THEMES[current] || THEMES.dark;
  $("accent-picker").value = localStorage.getItem("accent") || t.vars["--accent"];
}

$("accent-picker").oninput = (e) => {
  localStorage.setItem("accent", e.target.value);
  applyTheme();
};
$("accent-reset").onclick = () => {
  localStorage.removeItem("accent");
  applyTheme();
  renderAppearance();
};

/* ---------------- boot ---------------- */

(async function init() {
  document.title = "JARVIS";
  applyTheme();
  const saved = localStorage.getItem("session");
  await boot();
  if (state.token) {
    if (saved && state.sessions.some((s) => s.id === saved)) await selectSession(saved);
    else await newSession();
    setInterval(() => { if (!document.hidden) loadJobs(); }, 5000);
  }
})();