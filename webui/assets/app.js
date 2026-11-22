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

const PREF_DEFAULTS = {
  theme: "dark",
  accent: "",
  showThinking: true,
  showToolLog: true,
  voiceLang: "en-US",
  modelKey: "",
  modelPrefs: {},
  collapsedProjects: [],
};

const state = {
  token: localStorage.getItem("token") || "",
  sessionId: null,
  sessions: [],
  providers: [],
  projects: [],
  skills: [],
  mcpServers: [],
  jobs: [],
  busy: false,
  prefs: Object.assign({}, PREF_DEFAULTS),
  modelKey: "",
  abort: null,
  ctrl: null,
  jobId: null,
  detached: false,
  stopping: false,
  pendingFiles: [],
  dragId: null,
};

const uiState = { activity: null, answer: "", toolCount: 0 };

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ---------------- preferences: stored on the server, cached locally ---------------- */

function localPrefs() {
  try {
    return Object.assign({}, PREF_DEFAULTS, JSON.parse(localStorage.getItem("prefs") || "{}"));
  } catch {
    return Object.assign({}, PREF_DEFAULTS);
  }
}

function legacyPrefs() {
  const out = {};
  const theme = localStorage.getItem("theme");
  if (theme) out.theme = theme;
  const accent = localStorage.getItem("accent");
  if (accent) out.accent = accent;
  if (localStorage.getItem("showThinking") === "0") out.showThinking = false;
  if (localStorage.getItem("showToolLog") === "0") out.showToolLog = false;
  const mk = localStorage.getItem("modelKey");
  if (mk) out.modelKey = mk;
  try {
    const mp = JSON.parse(localStorage.getItem("modelPrefs") || "{}");
    if (Object.keys(mp).length) out.modelPrefs = mp;
  } catch { /* ignore */ }
  try {
    const cp = JSON.parse(localStorage.getItem("collapsedProjects") || "[]");
    if (cp.length) out.collapsedProjects = cp;
  } catch { /* ignore */ }
  return out;
}

function cachePrefs() {
  localStorage.setItem("prefs", JSON.stringify(state.prefs));
}

function syncPill(mode) {
  const pill = $("sync-pill");
  if (!pill) return;
  pill.dataset.mode = mode;
  $("sync-text").textContent = mode === "saving" ? "Saving…" : mode === "offline" ? "Local only" : "Synced";
}

let prefTimer = null;
let prefQueue = {};

function setPref(key, value) {
  state.prefs[key] = value;
  cachePrefs();
  applyPrefs();
  prefQueue[key] = value;
  syncPill("saving");
  clearTimeout(prefTimer);
  prefTimer = setTimeout(flushPrefs, 220);
}

async function flushPrefs() {
  const patch = prefQueue;
  prefQueue = {};
  if (!Object.keys(patch).length) return;
  try {
    const saved = await json(await api("/api/preferences", { method: "PUT", body: patch }));
    state.prefs = Object.assign({}, PREF_DEFAULTS, saved);
    cachePrefs();
    syncPill("synced");
  } catch {
    syncPill("offline");
  }
}

async function loadPrefs() {
  state.prefs = localPrefs();
  try {
    const server = await json(await api("/api/preferences"));
    const untouched = JSON.stringify(server) === JSON.stringify(PREF_DEFAULTS);
    const legacy = legacyPrefs();
    if (untouched && Object.keys(legacy).length) {
      state.prefs = Object.assign({}, PREF_DEFAULTS, await json(await api("/api/preferences", { method: "PUT", body: legacy })));
      ["theme", "accent", "showThinking", "showToolLog", "modelKey", "modelPrefs", "collapsedProjects", "autoTitle"]
        .forEach((k) => localStorage.removeItem(k));
    } else {
      state.prefs = Object.assign({}, PREF_DEFAULTS, server);
    }
    cachePrefs();
    syncPill("synced");
  } catch {
    syncPill("offline");
  }
  applyPrefs();
}

async function pullPrefs() {
  try {
    const server = Object.assign({}, PREF_DEFAULTS, await json(await api("/api/preferences")));
    if (JSON.stringify(server) === JSON.stringify(state.prefs)) return;
    state.prefs = server;
    cachePrefs();
    applyPrefs();
    renderSessions();
    if (!$("settings-modal").classList.contains("hidden")) renderAppearance();
    syncPill("synced");
  } catch { /* keep what we have */ }
}

function applyPrefs() {
  const p = state.prefs;
  applyTheme();
  document.body.classList.toggle("hide-thinking", !p.showThinking);
  document.body.classList.toggle("hide-toollog", !p.showToolLog);
  $("toggle-thinking").checked = !!p.showThinking;
  $("toggle-toollog").checked = !!p.showToolLog;
  const vl = $("voice-lang");
  if ([...vl.options].some((o) => o.value === p.voiceLang)) vl.value = p.voiceLang;
  if (p.modelKey) state.modelKey = p.modelKey;
}

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
  $("ws-path").textContent = health.workspace || "";
  if (!health.setup_done) { showScreen("setup-screen"); return; }
  if (!state.token) { showScreen("login-screen"); return; }
  try {
    await enterApp();
  } catch {
    state.token = "";
    localStorage.removeItem("token");
    showScreen("login-screen");
  }
}

async function enterApp() {
  await loadAll();
  showScreen("app");
  await startApp();
}

async function startApp() {
  const saved = localStorage.getItem("session");
  const running = state.jobs.find((j) => j.status === "running");
  if (saved && state.sessions.some((s) => s.id === saved)) await selectSession(saved);
  else if (running) await selectSession(running.session_id);
  else if (state.sessions.length) await selectSession(state.sessions[0].id);
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
  await loadPrefs();
  await Promise.all([
    loadSessions(), loadProviders(), loadModels(), loadSkills(),
    loadProjects(), loadJobs(), loadMcpCatalog(),
  ]);
}

async function loadProjects() {
  try {
    state.projects = await json(await api("/api/projects"));
  } catch { state.projects = []; }
  renderSessions();
  updateTopbar();
}

let jobSig = "";

async function loadJobs() {
  try {
    state.jobs = await json(await api("/api/jobs"));
  } catch { state.jobs = []; }
  const sig = state.jobs.map((j) => j.id + ":" + j.status).join(",");
  if (sig !== jobSig) {
    jobSig = sig;
    renderSessions();
  }
  updateBanner();
}

function runningJobFor(sessionId) {
  return state.jobs.find((j) => j.session_id === sessionId && j.status === "running") || null;
}

async function loadSkills() {
  try {
    state.skills = await json(await api("/api/skills"));
  } catch { state.skills = []; }
}

async function loadMcpCatalog(connect) {
  try {
    const data = await json(await api("/api/mcp/tools" + (connect ? "?connect=1" : "")));
    state.mcpServers = data.servers || [];
  } catch { state.mcpServers = []; }
  if (palette.open && palette.kind === "mcp") paintPalette();
  renderCmdChips();
}

async function loadModels() {
  const m = await json(await api("/api/models"));
  document.title = "JARVIS";
}

/* ---------------- sessions ---------------- */

let sessionsReq = 0;

function invalidateSessions() { sessionsReq++; }

async function loadSessions() {
  const seq = ++sessionsReq;
  const rows = await json(await api("/api/sessions"));
  if (seq !== sessionsReq) return;
  state.sessions = rows;
  renderSessions();
  updateTopbar();
}

const PROJECT_ICONS = ["📁", "🚀", "🧠", "💼", "🎨", "🛠️", "📚", "🧪", "🌐", "🎮", "🎵", "📷", "💡", "🔒", "🧩", "⚡", "🌱", "🏗️", "📊", "🤖", "❤️", "🗂️", "🧭", "🔬"];
const PROJECT_COLORS = ["#4f8cff", "#a78bfa", "#22c55e", "#fbbf24", "#fb7185", "#06b6d4", "#f472b6", "#a3e635", "#f97316", "#94a3b8"];

const projectIcon = (p) => (p && p.icon) || "📁";
const projectColor = (p) =>
  (p && p.color) || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4f8cff";

const CHAT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"/></svg>';
const DOTS_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';

function menuButton(label, onClick) {
  const b = el("button", "row-menu");
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = DOTS_SVG;
  b.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    onClick(b);
  };
  return b;
}

function clearDropMarks() {
  document.querySelectorAll(".drop-on").forEach((n) => n.classList.remove("drop-on"));
}

function wireDrop(node, projectId) {
  node.addEventListener("dragover", (e) => {
    if (!state.dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    node.classList.add("drop-on");
  });
  node.addEventListener("dragleave", (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove("drop-on");
  });
  node.addEventListener("drop", (e) => {
    e.preventDefault();
    const id = state.dragId || e.dataTransfer.getData("text/plain");
    clearDropMarks();
    document.body.classList.remove("dragging-chat");
    if (id) moveSession(id, projectId);
  });
}

function renderSessions() {
  const list = $("session-list");
  list.innerHTML = "";
  const collapsed = new Set(state.prefs.collapsedProjects || []);
  const byProject = new Map();
  const loose = [];
  for (const s of state.sessions) {
    if (s.project_id && state.projects.some((p) => p.id === s.project_id)) {
      if (!byProject.has(s.project_id)) byProject.set(s.project_id, []);
      byProject.get(s.project_id).push(s);
    } else loose.push(s);
  }

  const makeRow = (s, sub) => {
    const item = el("div", "session-item" + (sub ? " sub" : "") + (s.id === state.sessionId ? " active" : ""));
    item.draggable = true;
    item.dataset.id = s.id;
    item.innerHTML = `<span class="session-ico">${CHAT_SVG}</span>`;
    const title = el("span", "session-title", s.title || "Untitled");
    title.title = s.title || "Untitled";
    item.appendChild(title);
    if (runningJobFor(s.id)) {
      const dot = el("span", "run-dot");
      dot.title = "Working in background";
      item.appendChild(dot);
    }
    item.appendChild(menuButton("Chat options", (b) => openMenuAt(b, sessionMenu(s))));
    item.onclick = () => selectSession(s.id);
    item.oncontextmenu = (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, sessionMenu(s));
    };
    item.ondragstart = (e) => {
      state.dragId = s.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", s.id);
      item.classList.add("dragging");
      document.body.classList.add("dragging-chat");
    };
    item.ondragend = () => {
      state.dragId = null;
      item.classList.remove("dragging");
      document.body.classList.remove("dragging-chat");
      clearDropMarks();
    };
    return item;
  };

  const projLabel = el("div", "list-label projects-label");
  projLabel.appendChild(el("span", null, "Projects"));
  const addBtn = el("button", "label-add", "+");
  addBtn.type = "button";
  addBtn.title = "New project";
  addBtn.setAttribute("aria-label", "New project");
  addBtn.onclick = async (e) => {
    e.stopPropagation();
    await createProjectModal();
  };
  projLabel.appendChild(addBtn);
  list.appendChild(projLabel);

  for (const p of state.projects) {
    const kids = byProject.get(p.id) || [];
    const folder = el("div", "proj-folder");
    folder.dataset.project = p.id;
    folder.style.setProperty("--pc", projectColor(p));
    const row = el("div", "folder-row");
    const head = el("button", "folder-head");
    head.type = "button";
    head.title = p.name;
    head.innerHTML =
      `<svg class="fold-chev${collapsed.has(p.id) ? "" : " open"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>` +
      `<span class="fold-ico">${esc(projectIcon(p))}</span>` +
      `<span class="folder-name">${esc(p.name)}</span><span class="folder-count">${kids.length}</span>`;
    head.onclick = () => {
      if (collapsed.has(p.id)) collapsed.delete(p.id); else collapsed.add(p.id);
      setPref("collapsedProjects", [...collapsed]);
      renderSessions();
    };
    head.oncontextmenu = (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, projectMenu(p));
    };
    row.appendChild(head);
    row.appendChild(menuButton("Project options", (b) => openMenuAt(b, projectMenu(p))));
    folder.appendChild(row);
    if (!collapsed.has(p.id)) {
      const box = el("div", "folder-kids");
      if (!kids.length) box.appendChild(el("p", "muted small folder-empty", "No chats yet — drag one here, or ⋯ → New chat here."));
      for (const s of kids) box.appendChild(makeRow(s, true));
      folder.appendChild(box);
    }
    wireDrop(folder, p.id);
    list.appendChild(folder);
  }

  if (!state.projects.length) {
    const empty = el("button", "proj-empty");
    empty.type = "button";
    empty.innerHTML = '<span class="pe-plus">+</span><span><b>Create a project</b><span class="muted small">Group chats with shared instructions and knowledge.</span></span>';
    empty.onclick = () => createProjectModal();
    list.appendChild(empty);
  }

  const looseLabel = el("div", "list-label", state.projects.length ? "Chats" : "Recent chats");
  list.appendChild(looseLabel);
  const looseBox = el("div", "loose-box");
  for (const s of loose) looseBox.appendChild(makeRow(s, false));
  if (!loose.length) looseBox.appendChild(el("p", "muted small folder-empty loose-empty", "Drag a chat here to take it out of its project."));
  wireDrop(looseBox, null);
  list.appendChild(looseBox);
}

function updateTopbar() {
  const s = state.sessions.find((x) => x.id === state.sessionId);
  $("chat-title").textContent = (s && s.title) || "New chat";
  $("chat-title-btn").title = s ? "Rename this chat" : "New chat";
  const p = s && s.project_id ? state.projects.find((x) => x.id === s.project_id) : null;
  const chip = $("proj-chip");
  chip.classList.toggle("hidden", !p);
  if (p) {
    chip.style.setProperty("--pc", projectColor(p));
    chip.innerHTML = `<span class="chip-ico">${esc(projectIcon(p))}</span><span class="chip-name">${esc(p.name)}</span>`;
  }
  $("composer-ctx").textContent = p ? `${projectIcon(p)} ${p.name} context is attached to every message` : "";
}

async function newSession(projectId) {
  $("app").classList.remove("nav-open");
  if (state.busy) detachQuietly();
  clearRunState();
  const s = await json(await api("/api/sessions", {
    method: "POST",
    body: { project_id: projectId || null },
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
  $("app").classList.remove("nav-open");
  if (state.busy && state.sessionId !== id) detachQuietly();
  clearRunState();
  state.sessionId = id;
  localStorage.setItem("session", id);
  const msgs = await json(await api(`/api/sessions/${id}/messages`));
  applyModelPrefFor(id);
  renderChat(msgs);
  renderSessions();
  updateTopbar();
  await loadJobs();
  const job = bgJobFor(id);
  if (job && !state.busy) await resumeJob(job.id);
}

$("new-chat-btn").onclick = () => newSession();
$("menu-btn").onclick = () => $("app").classList.toggle("nav-open");
$("sidebar-scrim").onclick = () => $("app").classList.remove("nav-open");
$("chat-title-btn").onclick = () => {
  const s = state.sessions.find((x) => x.id === state.sessionId);
  if (s) renameSession(s);
};
$("proj-chip").onclick = () => {
  const s = state.sessions.find((x) => x.id === state.sessionId);
  const p = s && state.projects.find((x) => x.id === s.project_id);
  if (p) { openSettings(); selectSetTab("projects"); openProjectDetail(p.id); }
};

/* ---------------- toasts ---------------- */

function toast(text, opts = {}) {
  const box = $("toasts");
  const t = el("div", "toast" + (opts.kind ? " " + opts.kind : ""));
  t.appendChild(el("span", "toast-text", text));
  if (opts.action) {
    const b = el("button", "toast-act", opts.action);
    b.type = "button";
    b.onclick = () => {
      t.remove();
      opts.onAction && opts.onAction();
    };
    t.appendChild(b);
  }
  const close = el("button", "toast-x", "✕");
  close.type = "button";
  close.onclick = () => t.remove();
  t.appendChild(close);
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  const life = opts.action ? 7000 : 3200;
  setTimeout(() => {
    t.classList.remove("in");
    setTimeout(() => t.remove(), 260);
  }, life);
  while (box.children.length > 4) box.firstChild.remove();
}

/* ---------------- context menu ---------------- */

let menuStack = [];

function closeMenu() {
  const m = $("ctx-menu");
  m.classList.add("hidden");
  m.innerHTML = "";
  menuStack = [];
}

function paintMenu() {
  const m = $("ctx-menu");
  const top = menuStack[menuStack.length - 1];
  if (!top) return closeMenu();
  m.innerHTML = "";
  m.classList.remove("hidden");
  if (menuStack.length > 1) {
    const back = el("button", "ctx-item ctx-back", "‹ Back");
    back.type = "button";
    back.onclick = () => { menuStack.pop(); paintMenu(); };
    m.appendChild(back);
    m.appendChild(el("div", "ctx-title", top.title || ""));
  } else if (top.title) {
    m.appendChild(el("div", "ctx-title", top.title));
  }
  for (const it of top.items) {
    if (it.sep) { m.appendChild(el("div", "ctx-sep")); continue; }
    const b = el("button", "ctx-item" + (it.danger ? " danger" : ""));
    b.type = "button";
    const ico = el("span", "ctx-ico", it.icon || "");
    if (it.color) ico.style.color = it.color;
    b.appendChild(ico);
    b.appendChild(el("span", "ctx-label", it.label));
    if (it.sub) b.appendChild(el("span", "ctx-arrow", "›"));
    if (it.checked) b.appendChild(el("span", "ctx-check", "✓"));
    b.onclick = (e) => {
      e.stopPropagation();
      if (it.sub) {
        menuStack.push({ x: top.x, y: top.y, items: it.sub, title: it.label });
        paintMenu();
      } else {
        const fn = it.onClick;
        closeMenu();
        fn && fn();
      }
    };
    m.appendChild(b);
  }
  m.style.left = "0px";
  m.style.top = "0px";
  const r = m.getBoundingClientRect();
  const pad = 8;
  let x = top.align === "right" ? top.x - r.width : top.x;
  let y = top.y;
  x = Math.max(pad, Math.min(x, window.innerWidth - r.width - pad));
  y = Math.max(pad, Math.min(y, window.innerHeight - r.height - pad));
  m.style.left = x + "px";
  m.style.top = y + "px";
  m.classList.add("in");
}

function openMenu(x, y, items, title) {
  menuStack = [{ x, y, items, title }];
  paintMenu();
}

function openMenuAt(btn, items, title) {
  const r = btn.getBoundingClientRect();
  menuStack = [{ x: r.right, y: r.bottom + 4, items, title, align: "right" }];
  paintMenu();
}

document.addEventListener("click", (e) => {
  if (!menuStack.length) return;
  if (!$("ctx-menu").contains(e.target)) closeMenu();
});
document.addEventListener("contextmenu", (e) => {
  if (menuStack.length && !$("ctx-menu").contains(e.target)) closeMenu();
});
window.addEventListener("resize", closeMenu);
document.addEventListener("scroll", (e) => {
  if (menuStack.length && !$("ctx-menu").contains(e.target)) closeMenu();
}, true);

/* ---------------- modal ---------------- */

let modalResolve = null;
let modalRead = null;
let modalValidate = null;

function showModalErr(msg) {
  const e = $("modal-err");
  e.textContent = msg;
  e.classList.remove("hidden");
}

function openModal(opts) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    modalRead = opts.read || (() => ({}));
    modalValidate = opts.validate || null;
    const card = $("modal-card");
    $("modal-title").textContent = opts.title || "";
    $("modal-text").textContent = opts.text || "";
    $("modal-text").classList.toggle("hidden", !opts.text);
    $("modal-ico").textContent = opts.icon || "✎";
    card.classList.toggle("danger", !!opts.danger);
    const body = $("modal-body");
    body.innerHTML = "";
    if (opts.body) opts.body(body);
    body.classList.toggle("hidden", !opts.body);
    $("modal-ok").textContent = opts.okLabel || "Save";
    $("modal-cancel").textContent = opts.cancelLabel || "Cancel";
    $("modal-err").classList.add("hidden");
    $("modal-root").classList.remove("hidden");
    document.body.classList.add("modal-open");
    requestAnimationFrame(() => card.classList.add("in"));
    setTimeout(() => {
      const f = body.querySelector("input, textarea, select") || $("modal-ok");
      f.focus();
      if (f.select && f.tagName === "INPUT") f.select();
    }, 40);
  });
}

function closeModal(result) {
  const card = $("modal-card");
  card.classList.remove("in");
  $("modal-root").classList.add("hidden");
  document.body.classList.remove("modal-open");
  const r = modalResolve;
  modalResolve = null;
  modalRead = null;
  modalValidate = null;
  if (r) r(result);
}

function submitModal() {
  if (!modalResolve) return;
  let values;
  try { values = modalRead ? modalRead() : {}; }
  catch (e) { return showModalErr(e.message); }
  const err = modalValidate ? modalValidate(values) : null;
  if (err) return showModalErr(err);
  closeModal(values);
}

function modalField(body, o) {
  const wrap = el("label", "modal-field");
  wrap.appendChild(el("span", "field-label", o.label));
  const inp = document.createElement(o.multiline ? "textarea" : "input");
  if (!o.multiline) inp.type = o.type || "text";
  inp.value = o.value || "";
  inp.placeholder = o.placeholder || "";
  if (o.maxlength) inp.maxLength = o.maxlength;
  if (o.rows) inp.rows = o.rows;
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !o.multiline) { e.preventDefault(); submitModal(); }
    if (e.key === "Enter" && o.multiline && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitModal(); }
  });
  wrap.appendChild(inp);
  body.appendChild(wrap);
  return inp;
}

$("modal-ok").onclick = submitModal;
$("modal-cancel").onclick = () => closeModal(null);
$("modal-scrim").onclick = () => closeModal(null);
document.addEventListener("keydown", (e) => {
  if (!$("modal-root").classList.contains("hidden")) {
    if (e.key === "Escape") { e.preventDefault(); closeModal(null); return; }
    if (e.key === "Tab") {
      const f = [...$("modal-card").querySelectorAll("button, input, textarea, select, [tabindex]")].filter((n) => !n.disabled && n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  if (e.key === "Escape" && menuStack.length) { e.preventDefault(); closeMenu(); }
});

/* ---------------- folder style picker ---------------- */

function mountStylePicker(grid, swatches, preview, cur) {
  const sel = { icon: cur.icon || "📁", color: cur.color || PROJECT_COLORS[0] };
  const paint = () => {
    preview.textContent = sel.icon;
    preview.style.setProperty("--pc", sel.color);
    [...grid.children].forEach((b) => b.classList.toggle("on", b.dataset.icon === sel.icon));
    [...swatches.querySelectorAll(".swatch")].forEach((b) => b.classList.toggle("on", b.dataset.color === sel.color));
  };
  grid.innerHTML = "";
  for (const ico of PROJECT_ICONS) {
    const b = el("button", "icon-cell", ico);
    b.type = "button";
    b.dataset.icon = ico;
    b.title = "Use " + ico;
    b.onclick = () => { sel.icon = ico; paint(); };
    grid.appendChild(b);
  }
  swatches.innerHTML = "";
  for (const c of PROJECT_COLORS) {
    const b = el("button", "swatch");
    b.type = "button";
    b.dataset.color = c;
    b.style.setProperty("--pc", c);
    b.title = c;
    b.onclick = () => { sel.color = c; paint(); };
    swatches.appendChild(b);
  }
  const custom = document.createElement("input");
  custom.type = "color";
  custom.className = "swatch-custom";
  custom.value = sel.color;
  custom.title = "Custom colour";
  custom.oninput = () => { sel.color = custom.value; paint(); };
  swatches.appendChild(custom);
  paint();
  return sel;
}

function stylePickerBody(body, cur) {
  body.appendChild(el("span", "field-label", "Folder icon & colour"));
  const row = el("div", "style-row");
  const preview = el("span", "proj-preview");
  const pick = el("div", "style-pickers");
  const grid = el("div", "icon-grid");
  const sw = el("div", "swatch-row");
  pick.append(grid, sw);
  row.append(preview, pick);
  body.appendChild(row);
  return mountStylePicker(grid, sw, preview, cur);
}

/* ---------------- chat actions ---------------- */

function sessionMenu(s) {
  return [
    { label: "Rename chat", icon: "✎", onClick: () => renameSession(s) },
    { label: "Move to project", icon: "🗂", sub: moveItems(s), title: "Move “" + (s.title || "Untitled") + "”" },
    { sep: true },
    { label: "Delete chat", icon: "🗑", danger: true, onClick: () => deleteSession(s) },
  ];
}

function moveItems(s) {
  const cur = s.project_id || null;
  const out = [{ label: "No project", icon: "💬", checked: !cur, onClick: () => moveSession(s.id, null) }];
  for (const p of state.projects) {
    out.push({ label: p.name, icon: projectIcon(p), color: projectColor(p), checked: cur === p.id, onClick: () => moveSession(s.id, p.id) });
  }
  if (state.projects.length) out.push({ sep: true });
  out.push({
    label: "New project…", icon: "＋", onClick: async () => {
      const p = await createProjectModal();
      if (p) moveSession(s.id, p.id);
    },
  });
  return out;
}

async function renameSession(s) {
  let input;
  const res = await openModal({
    title: "Rename chat",
    text: "Give this chat a name you will recognise later.",
    icon: "✎",
    okLabel: "Save name",
    body: (b) => { input = modalField(b, { label: "Chat name", value: s.title || "", placeholder: "Fix the login bug", maxlength: 120 }); },
    read: () => ({ title: input.value.trim() }),
    validate: (v) => (v.title ? null : "Enter a name first."),
  });
  if (!res) return;
  const old = s.title;
  invalidateSessions();
  s.title = res.title;
  renderSessions();
  updateTopbar();
  try {
    await api(`/api/sessions/${s.id}/title`, { method: "POST", body: { title: res.title } });
    await loadSessions();
    toast("Chat renamed");
  } catch (e) {
    s.title = old;
    renderSessions();
    updateTopbar();
    toast("Rename failed: " + e.message, { kind: "error" });
  }
}

async function deleteSession(s) {
  const running = runningJobFor(s.id);
  const res = await openModal({
    title: "Delete this chat?",
    text: `“${s.title || "Untitled"}” and all of its messages will be permanently removed from the server${running ? ", and the task running in it will be stopped" : ""}. This cannot be undone.`,
    icon: "🗑",
    danger: true,
    okLabel: "Delete chat",
    cancelLabel: "Keep it",
  });
  if (!res) return;
  if (running) { try { await api(`/api/sessions/${s.id}/stop`, { method: "POST" }); } catch {} }
  const wasActive = state.sessionId === s.id;
  invalidateSessions();
  state.sessions = state.sessions.filter((x) => x.id !== s.id);
  if (wasActive) { state.sessionId = null; renderChat(null); }
  renderSessions();
  updateTopbar();
  try {
    await api("/api/sessions/" + s.id, { method: "DELETE" });
    await loadSessions();
    await loadJobs();
    toast("Chat deleted");
    if (wasActive) {
      if (state.sessions.length) await selectSession(state.sessions[0].id);
      else await newSession();
    }
  } catch (e) {
    toast("Delete failed: " + e.message, { kind: "error" });
    await loadSessions();
  }
}

async function moveSession(id, projectId) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const from = s.project_id || null;
  if (from === projectId) return;
  const name = (state.projects.find((p) => p.id === projectId) || {}).name || "Chats";
  invalidateSessions();
  s.project_id = projectId;
  renderSessions();
  updateTopbar();
  try {
    await api(`/api/sessions/${id}/project`, { method: "POST", body: { project_id: projectId } });
    await loadSessions();
    toast(`Moved to ${name}`, { action: "Undo", onAction: () => moveSession(id, from) });
  } catch (e) {
    s.project_id = from;
    renderSessions();
    updateTopbar();
    toast("Move failed: " + e.message, { kind: "error" });
  }
}

/* ---------------- project actions ---------------- */

function projectMenu(p) {
  return [
    { label: "New chat here", icon: "＋", onClick: () => newSession(p.id) },
    { label: "Rename project", icon: "✎", onClick: () => renameProject(p) },
    { label: "Icon & colour", icon: "🎨", onClick: () => styleProject(p) },
    { label: "Instructions & knowledge", icon: "📚", onClick: () => { openSettings(); selectSetTab("projects"); openProjectDetail(p.id); } },
    { sep: true },
    { label: "Delete project", icon: "🗑", danger: true, onClick: () => deleteProject(p) },
  ];
}

async function createProjectModal() {
  let input, sel;
  const res = await openModal({
    title: "New project",
    text: "A folder of chats that share instructions and knowledge files.",
    icon: "🗂",
    okLabel: "Create project",
    body: (b) => {
      input = modalField(b, { label: "Project name", placeholder: "My App", maxlength: 80 });
      sel = stylePickerBody(b, {});
    },
    read: () => ({ name: input.value.trim(), icon: sel.icon, color: sel.color }),
    validate: (v) => (v.name ? null : "Give the project a name."),
  });
  if (!res) return null;
  try {
    const p = await json(await api("/api/projects", { method: "POST", body: res }));
    await loadProjects();
    toast(`Project “${p.name}” created`);
    return p;
  } catch (e) {
    toast("Could not create project: " + e.message, { kind: "error" });
    return null;
  }
}

async function renameProject(p) {
  let input;
  const res = await openModal({
    title: "Rename project",
    icon: "✎",
    okLabel: "Save name",
    body: (b) => { input = modalField(b, { label: "Project name", value: p.name, maxlength: 80 }); },
    read: () => ({ name: input.value.trim() }),
    validate: (v) => (v.name ? null : "Enter a name first."),
  });
  if (!res) return;
  try {
    await api("/api/projects/" + p.id, { method: "PUT", body: { name: res.name, instructions: p.instructions || "", icon: p.icon || "", color: p.color || "" } });
    await loadProjects();
    toast("Project renamed");
  } catch (e) {
    toast("Rename failed: " + e.message, { kind: "error" });
  }
}

async function styleProject(p) {
  let sel;
  const res = await openModal({
    title: "Folder icon & colour",
    text: `Shown next to “${p.name}” in the sidebar and on every chat inside it.`,
    icon: "🎨",
    okLabel: "Apply",
    body: (b) => { sel = stylePickerBody(b, p); },
    read: () => ({ icon: sel.icon, color: sel.color }),
  });
  if (!res) return;
  try {
    await api("/api/projects/" + p.id, { method: "PUT", body: { name: p.name, instructions: p.instructions || "", icon: res.icon, color: res.color } });
    await loadProjects();
    toast("Folder style updated");
  } catch (e) {
    toast("Update failed: " + e.message, { kind: "error" });
  }
}

async function deleteProject(p) {
  const kids = state.sessions.filter((s) => s.project_id === p.id).length;
  const res = await openModal({
    title: "Delete this project?",
    text: `“${p.name}” and its ${p.file_count || 0} knowledge file(s) will be removed. ${kids ? kids + " chat(s) move back to Chats — their history is kept." : "No chats are inside it."}`,
    icon: "🗑",
    danger: true,
    okLabel: "Delete project",
    cancelLabel: "Keep it",
  });
  if (!res) return;
  try {
    await api("/api/projects/" + p.id, { method: "DELETE" });
    await loadProjects();
    await loadSessions();
    if (openProject === p.id) { openProject = null; $("proj-detail").classList.add("hidden"); }
    loadProjectsTab();
    toast("Project deleted");
  } catch (e) {
    toast("Delete failed: " + e.message, { kind: "error" });
  }
}

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

function clearRunState() {
  if (state.ctrl) state.ctrl.abort();
  state.ctrl = null;
  stopBgWatch();
  state.jobId = null;
  state.detached = false;
  setBusyUI(false);
}

function bgJobFor(sessionId) {
  if (!sessionId) return null;
  const live = runningJobFor(sessionId);
  if (live) return live;
  return state.jobs.find((j) => j.id === state.jobId && j.session_id === sessionId) || null;
}

function updateBanner() {
  const banner = $("bg-banner");
  const job = bgJobFor(state.sessionId);
  if (job && !state.busy) {
    banner.dataset.job = job.id;
    banner.classList.remove("hidden");
    $("bg-text").textContent = "Working in the background — close this window if you like, it keeps running.";
    $("send-btn").textContent = "▶";
    $("send-btn").title = "Resume the running task";
  } else {
    banner.classList.add("hidden");
    delete banner.dataset.job;
    if (!state.busy) {
      $("send-btn").textContent = "↑";
      $("send-btn").title = "Send message";
    }
  }
}

function pushToBackground() {
  if (!state.busy || !state.jobId) return false;
  state.detached = true;
  if (state.ctrl) state.ctrl.abort();
  setBusyUI(false);
  updateBanner();
  if (uiState.activity) uiState.activity.status("Working in background…");
  watchJobQuietly(state.jobId);
  return true;
}

/* While pushed away we still follow the server stream, so the pill shows real
   progress ("12 tool calls · run_command") instead of looking frozen. */
let bgWatch = null;

function stopBgWatch() {
  if (bgWatch) bgWatch.abort();
  bgWatch = null;
}

async function watchJobQuietly(jobId) {
  if (!jobId) return;
  stopBgWatch();
  const ctrl = new AbortController();
  bgWatch = ctrl;
  let tools = 0;
  let lastTool = "";
  let ended = false;
  const started = Date.now();
  const paint = () => {
    if (state.jobId !== jobId || !uiState.activity) return;
    const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
    uiState.activity.status(
      lastTool
        ? `Working in background… · ${tools} tool call${tools === 1 ? "" : "s"} · ${lastTool}`
        : `Working in background… · ${secs}s`
    );
  };
  try {
    const r = await api(`/api/jobs/${jobId}/stream?after=0`, { signal: ctrl.signal });
    if (!r.ok || !r.body) return;
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, nl).split("\n").find((l) => l.startsWith("data: "));
        buf = buf.slice(nl + 2);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === "tool_call") { tools++; lastTool = ev.name || ""; }
        if (ev.type === "done" || ev.type === "error") ended = true;
        if (ev.type !== "job") paint();
      }
    }
  } catch { /* aborted, offline, or the tab went away */ }
  if (bgWatch === ctrl) bgWatch = null;
  if (ended && state.detached && state.jobId === jobId && !state.busy) resumeJob(jobId);
}

function detachQuietly() {
  if (pushToBackground()) return;
  if (!state.busy) return;
  state.detached = true;
  if (state.ctrl) state.ctrl.abort();
  state.ctrl = null;
  setBusyUI(false);
  loadJobs().then(() => { updateBanner(); renderSessions(); watchJobQuietly(state.jobId); }).catch(() => {});
}

$("push-btn").onclick = async () => {
  if (!state.busy) return;
  const btn = $("push-btn");
  if (!state.jobId) {
    btn.disabled = true;
    await loadJobs();
    const job = bgJobFor(state.sessionId);
    if (job) state.jobId = job.id;
    btn.disabled = false;
  }
  if (!pushToBackground()) {
    toast("JARVIS has not reached the server yet — try again in a second.", { kind: "warn" });
    return;
  }
  toast("Task pushed to the background — it keeps running on the server.", { kind: "info" });
};

$("bg-resume").onclick = () => {
  const job = bgJobFor(state.sessionId);
  const id = (job && job.id) || $("bg-banner").dataset.job;
  if (id) resumeJob(id);
};

$("bg-stop").onclick = async () => {
  if (!bgJobFor(state.sessionId) && !$("bg-banner").dataset.job) return;
  $("bg-text").textContent = "Stopping the task…";
  await stopCurrent();
  toast("Task stopped on the server.", { kind: "warn" });
};

async function stopCurrent() {
  if (state.stopping) return;
  const sid = state.sessionId;
  const run = bgJobFor(sid);
  const jobId = state.jobId || (run && run.id);
  if (!state.busy && !jobId) return;
  state.stopping = true;
  state.detached = false;
  if (uiState.activity) uiState.activity.status("Stopping…");
  const calls = [];
  if (jobId) calls.push(api(`/api/jobs/${jobId}/stop`, { method: "POST" }).catch(() => {}));
  if (sid) calls.push(api(`/api/sessions/${sid}/stop`, { method: "POST" }).catch(() => {}));
  await Promise.all(calls);
  if (state.ctrl) state.ctrl.abort();
  state.ctrl = null;
  stopBgWatch();
  state.jobId = null;
  state.stopping = false;
  setBusyUI(false);
  await loadJobs();
  renderSessions();
  $("input").focus();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (state.busy) detachQuietly();
    flushPrefs();
    return;
  }
  pullPrefs();
  loadJobs().then(() => {
    updateBanner();
    renderSessions();
    const job = bgJobFor(state.sessionId);
    if (job && !state.busy && state.detached) resumeJob(job.id);
  }).catch(() => {});
});
window.addEventListener("pagehide", () => {
  if (state.busy) detachQuietly();
  flushPrefs();
});

window.addEventListener("beforeunload", (e) => {
  if (!state.busy || state.detached) return;
  e.preventDefault();
  e.returnValue = "";
  setTimeout(() => {
    if (state.busy && !state.detached && document.visibilityState === "visible") askLeaveChoice();
  }, 500);
});

async function askLeaveChoice() {
  const r = await openModal({
    title: "JARVIS is still working on this prompt",
    text: "Closing the tab does not stop it — the server runs every remaining step. Run it in the background, or stay and watch it live.",
    icon: "⤓",
    okLabel: "Run in background",
    cancelLabel: "Stay in this tab",
  });
  if (r) pushToBackground();
}

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
  closePalette();
  if (state.stopping || state.busy) return false;
  if ((!text && !attachments.length) || !state.sessionId) return false;
  const running = bgJobFor(state.sessionId);
  if (running) {
    toast("A task is already running in this chat — press ↑ to resume it, or ⏹ to stop it.", { kind: "warn" });
    return false;
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
      return false;
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
  const cur = state.sessions.find((s) => s.id === state.sessionId);
  if (cur && (!cur.title || cur.title === "New chat")) {
    cur.title = userText.replace(/(^|\s)\/[a-z0-9-]+/gi, " ").replace(/(^|\s)@[a-z0-9_-]+/gi, " ").trim().slice(0, 48) || "New chat";
    renderSessions();
    updateTopbar();
  }
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
    if (state.ctrl === ctrl) {
      state.ctrl = null;
      setBusyUI(false);
      if (!state.detached) { state.jobId = null; $("input").focus(); }
    }
    loadJobs();
  }
}

async function resumeJob(jobId) {
  if (state.busy || state.stopping) return;
  stopBgWatch();
  const job = state.jobs.find((j) => j.id === jobId);
  const sid = job ? job.session_id : state.sessionId;
  if (!sid) return;
  if (sid !== state.sessionId) {
    state.sessionId = sid;
    localStorage.setItem("session", sid);
    applyModelPrefFor(sid);
    renderSessions();
    updateTopbar();
  }
  try {
    state.jobs = await json(await api("/api/jobs"));
  } catch { /* keep cached list */ }
  const fresh = state.jobs.find((j) => j.id === jobId);
  let msgs;
  try {
    msgs = await json(await api(`/api/sessions/${sid}/messages`));
  } catch {
    toast("Could not reopen this task — check your connection.", { kind: "error" });
    return;
  }
  renderChat(msgs);
  if (!fresh || fresh.status !== "running") {
    state.jobId = null;
    state.detached = false;
    setBusyUI(false);
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
    if (state.ctrl === ctrl) {
      state.ctrl = null;
      setBusyUI(false);
      if (!state.detached) state.jobId = null;
    }
    loadJobs();
  }
}

$("send-btn").onclick = async () => {
  if (state.busy) { await stopCurrent(); return; }
  const job = bgJobFor(state.sessionId);
  if (job) { await resumeJob(job.id); return; }
  send();
};

function submitPrimary() {
  const hasDraft = !!($("input").value.trim() || state.pendingFiles.length);
  if (state.busy) {
    if (hasDraft) toast("JARVIS is still working — press ⏹ to stop it, or ⤓ to let it run in the background.", { kind: "warn" });
    return;
  }
  if (state.stopping) return;
  const job = bgJobFor(state.sessionId);
  if (job) {
    if (hasDraft) toast("This chat already has a task running — press ⏹ to stop it first.", { kind: "warn" });
    else resumeJob(job.id);
    return;
  }
  send();
}

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
      if (!ev.stopped) loadSessions().catch(() => {});
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
    setPref("modelKey", sel.value);
    if (state.sessionId) {
      setPref("modelPrefs", Object.assign({}, state.prefs.modelPrefs, { [state.sessionId]: sel.value }));
    }
  };
}

function applyModelPrefFor(sessionId) {
  const sel = $("model-select");
  const pref = (state.prefs.modelPrefs || {})[sessionId];
  const target = pref && [...sel.options].some((o) => o.value === pref) ? pref : state.modelKey;
  if (target && [...sel.options].some((o) => o.value === target)) {
    sel.value = target;
    state.modelKey = target;
  }
}

/* ---------------- composer ---------------- */

const input = $("input");

const palette = { open: false, kind: null, items: [], index: 0, token: null };

function commandTokens(text) {
  const out = [];
  const re = /(^|[\s(])([/@])([A-Za-z0-9][A-Za-z0-9_-]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    out.push({
      kind: m[2] === "/" ? "skill" : "mcp",
      id: m[3],
      start,
      end: start + 1 + m[3].length,
      raw: m[2] + m[3],
    });
  }
  return out;
}

function resolveToken(t) {
  const id = t.id.toLowerCase();
  if (t.kind === "skill") {
    const s = state.skills.find((x) => x.id === id);
    return s ? { label: s.title || s.id, icon: "✦", color: "", sub: s.description || "" } : null;
  }
  const s = state.mcpServers.find((x) => x.slug.toLowerCase() === id && x.enabled);
  return s ? { label: s.name, icon: "🔌", color: "", sub: `${s.tools.length} tool(s)${s.connected ? "" : " · connects on first use"}` } : null;
}

function activeToken() {
  const pos = input.selectionStart || 0;
  const before = input.value.slice(0, pos);
  const m = /(^|[\s(])([/@])([A-Za-z0-9_-]*)$/.exec(before);
  if (!m) return null;
  return { kind: m[2] === "/" ? "skill" : "mcp", query: m[3].toLowerCase(), start: pos - m[3].length - 1, end: pos };
}

function paletteItems(kind, query) {
  if (kind === "skill") {
    return state.skills
      .filter((s) => !query || s.id.includes(query) || (s.title || "").toLowerCase().includes(query))
      .slice(0, 40)
      .map((s) => ({ value: s.id, icon: "✦", label: "/" + s.id, sub: s.title || s.description || "" }));
  }
  return state.mcpServers
    .filter((s) => s.enabled)
    .filter((s) => !query || s.slug.toLowerCase().includes(query) || s.name.toLowerCase().includes(query))
    .slice(0, 40)
    .map((s) => ({
      value: s.slug,
      icon: "🔌",
      label: "@" + s.slug,
      sub: s.name + (s.tools.length ? ` · ${s.tools.length} tools` : s.connected ? "" : " · asleep"),
      off: !s.connected,
    }));
}

function closePalette() {
  palette.open = false;
  palette.token = null;
  $("cmd-palette").classList.add("hidden");
}

function paintPalette() {
  const box = $("cmd-palette");
  const list = $("cmd-list");
  $("cmd-kind").textContent = palette.kind === "skill" ? "Skills" : "MCP servers";
  list.innerHTML = "";
  if (!palette.items.length) {
    const empty = el("div", "cmd-empty");
    if (palette.kind === "skill") {
      empty.innerHTML = '<b>No skill matches.</b><span class="muted small">Add markdown skills in Settings → Skills, then call them with /name.</span>';
    } else {
      empty.innerHTML = '<b>No MCP server matches.</b><span class="muted small">Connect one in Settings → MCP, then call it with @name.</span>';
    }
    const b = el("button", "cmd-empty-btn", palette.kind === "skill" ? "Open Skills settings" : "Open MCP settings");
    b.type = "button";
    b.onclick = () => { closePalette(); openSettings(); selectSetTab(palette.kind === "skill" ? "skills" : "mcp"); };
    empty.appendChild(b);
    list.appendChild(empty);
    $("cmd-foot").textContent = "Esc to dismiss";
    box.classList.remove("hidden");
    return;
  }
  palette.items.forEach((it, i) => {
    const row = el("button", "cmd-item" + (i === palette.index ? " on" : "") + (it.off ? " off" : ""));
    row.type = "button";
    row.appendChild(el("span", "cmd-ico", it.icon));
    const txt = el("span", "cmd-txt");
    txt.appendChild(el("b", null, it.label));
    txt.appendChild(el("span", "muted small", it.sub));
    row.appendChild(txt);
    row.appendChild(el("span", "cmd-enter", "↵"));
    row.onmouseenter = () => { palette.index = i; markPalette(); };
    row.onclick = (e) => { e.preventDefault(); pickPalette(i); };
    list.appendChild(row);
  });
  $("cmd-foot").innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> insert</span><span><kbd>Esc</kbd> dismiss</span>';
  box.classList.remove("hidden");
  markPalette();
}

function markPalette() {
  [...$("cmd-list").children].forEach((n, i) => n.classList && n.classList.toggle("on", i === palette.index));
  const on = $("cmd-list").querySelector(".cmd-item.on");
  if (on) on.scrollIntoView({ block: "nearest" });
}

function updatePalette() {
  const t = activeToken();
  if (!t) return closePalette();
  const items = paletteItems(t.kind, t.query);
  const sameKind = palette.open && palette.kind === t.kind;
  palette.open = true;
  palette.kind = t.kind;
  palette.token = t;
  palette.items = items;
  if (!sameKind || palette.index >= items.length) palette.index = 0;
  paintPalette();
}

function pickPalette(i) {
  const it = palette.items[i];
  const t = palette.token;
  if (!it || !t) return closePalette();
  const insert = (t.kind === "skill" ? "/" : "@") + it.value + " ";
  input.value = input.value.slice(0, t.start) + insert + input.value.slice(t.end);
  const caret = t.start + insert.length;
  closePalette();
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input"));
}

function movePalette(d) {
  if (!palette.items.length) return;
  palette.index = (palette.index + d + palette.items.length) % palette.items.length;
  markPalette();
}

function renderCmdChips() {
  const box = $("cmd-chips");
  const tokens = commandTokens(input.value).map((t) => ({ t, r: resolveToken(t) })).filter((x) => x.r);
  box.innerHTML = "";
  box.classList.toggle("hidden", !tokens.length);
  for (const { t, r } of tokens) {
    const chip = el("span", "cmd-chip " + t.kind);
    chip.appendChild(el("span", "cmd-chip-ico", r.icon));
    chip.appendChild(el("span", "cmd-chip-label", (t.kind === "skill" ? "/" : "@") + t.id));
    chip.title = r.sub || r.label;
    const x = el("button", "cmd-chip-x", "✕");
    x.type = "button";
    x.title = "Remove " + t.raw;
    x.onclick = () => {
      let end = t.end;
      if (input.value[end] === " ") end++;
      input.value = input.value.slice(0, t.start) + input.value.slice(end);
      input.dispatchEvent(new Event("input"));
      input.focus();
    };
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

function insertTrigger(ch) {
  const pos = input.selectionStart || input.value.length;
  const before = input.value.slice(0, pos);
  const needSpace = before.length && !/\s$/.test(before);
  const add = (needSpace ? " " : "") + ch;
  input.value = before + add + input.value.slice(pos);
  const caret = pos + add.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input"));
}

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 220) + "px";
  updatePalette();
  renderCmdChips();
});
input.addEventListener("click", updatePalette);
input.addEventListener("keyup", (e) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updatePalette();
});
input.addEventListener("blur", () => setTimeout(() => {
  if (!$("cmd-palette").contains(document.activeElement)) closePalette();
}, 140));
input.addEventListener("keydown", (e) => {
  if (palette.open) {
    if (e.key === "ArrowDown") { e.preventDefault(); movePalette(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); movePalette(-1); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickPalette(palette.index); return; }
    if (e.key === "Escape") { e.preventDefault(); closePalette(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    submitPrimary();
  }
});
$("slash-hint").onclick = () => insertTrigger("/");
$("at-hint").onclick = () => insertTrigger("@");

/* ---- thinking / tool log visibility (Settings → Chat & logs, synced) ---- */

$("toggle-thinking").onchange = (e) => setPref("showThinking", e.target.checked);
$("toggle-toollog").onchange = (e) => setPref("showToolLog", e.target.checked);

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
$("voice-lang").onchange = (e) => {
  setPref("voiceLang", e.target.value);
  if (Voice.on) { Voice.stop(); setTimeout(() => Voice.restart(), 250); }
};

/* ---------------- settings page ---------------- */

$("settings-btn").onclick = openSettings;
$("settings-close").onclick = closeSettings;

function closeSettings() {
  stopBotPoll();
  $("settings-modal").classList.add("hidden");
}

function selectSetTab(name) {
  document.querySelectorAll(".set-item").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
  $("tab-" + name).classList.remove("hidden");
  if (name === "files") loadFileTree();
  if (name === "bots") loadIntegrations();
  if (name === "mcp") loadMcpTab();
  if (name === "skills") loadSkillsTab();
  if (name === "projects") loadProjectsTab();
  if (name === "appearance") renderAppearance();
  if (name === "chat") {
    $("toggle-thinking").checked = !!state.prefs.showThinking;
    $("toggle-toollog").checked = !!state.prefs.showToolLog;
  }
}

document.querySelectorAll(".set-item").forEach((t) => (t.onclick = () => selectSetTab(t.dataset.tab)));

$("settings-search").addEventListener("input", () => {
  const q = $("settings-search").value.trim().toLowerCase();
  let any = false;
  document.querySelectorAll(".set-item").forEach((it) => {
    const hit = !q || it.textContent.toLowerCase().includes(q) || (it.dataset.keys || "").toLowerCase().includes(q);
    it.classList.toggle("hidden", !hit);
    if (hit) any = true;
  });
  document.querySelectorAll(".set-group").forEach((g) => {
    let el = g.nextElementSibling;
    let visible = false;
    while (el && !el.classList.contains("set-group")) {
      if (el.classList.contains("set-item") && !el.classList.contains("hidden")) visible = true;
      el = el.nextElementSibling;
    }
    g.classList.toggle("hidden", !visible);
  });
  $("set-noresults").classList.toggle("hidden", any || !q);
});

$("settings-search").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const first = [...document.querySelectorAll(".set-item")].find((it) => !it.classList.contains("hidden"));
  if (!first) return;
  selectSetTab(first.dataset.tab);
  $("settings-search").value = "";
  $("settings-search").dispatchEvent(new Event("input"));
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("modal-root").classList.contains("hidden") || menuStack.length) return;
  if (!$("settings-modal").classList.contains("hidden")) closeSettings();
  else $("app").classList.remove("nav-open");
});

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
  $("app").classList.remove("nav-open");
  $("settings-modal").classList.remove("hidden");
  $("settings-search").value = "";
  $("settings-search").dispatchEvent(new Event("input"));
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
  if (r.ok) { $("new-pass").value = ""; toast("Password changed."); }
  else toast(j.detail || "Could not change password", { kind: "error" });
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
    url: $("mcp-url").value.trim(),
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
      $("mcp-url").value = "";
      $("mcp-command").disabled = false;
      $("mcp-args").disabled = false;
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
  list.innerHTML = servers.length ? "" : '<p class="muted small">No MCP servers yet — add a preset above, or a URL / custom command below.</p>';
  for (const s of servers) {
    const item = document.createElement("div");
    item.className = "provider-item";
    const target = s.url || (s.command + " " + (s.args || []).join(" "));
    item.innerHTML =
      `<div class="p-head"><span class="p-name">${esc(s.name)}</span><span class="p-badge">${esc(s.url ? "URL" : s.command)}</span><span style="flex:1"></span></div>` +
      `<p class="p-hint mono">${esc(target)}</p>` +
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
      out.textContent = s.url ? "testing…" : "testing… (the first npx run downloads the package, give it a minute)";
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

$("mcp-url").addEventListener("input", () => {
  const remote = !!$("mcp-url").value.trim();
  $("mcp-command").disabled = remote;
  $("mcp-args").disabled = remote;
  $("mcp-env").placeholder = remote
    ? "HTTP headers, one per line: KEY=VALUE\ne.g. Authorization=Bearer xxx"
    : "Environment variables, one per line: KEY=VALUE\ne.g. GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx";
});

$("mcp-test-btn").onclick = async () => {
  const body = mcpFormBody();
  if (!body.name || (!body.command && !body.url)) { $("mcp-out").textContent = "name and command or URL required"; return; }
  $("mcp-out").textContent = body.url ? "testing…" : "testing… (the first npx run downloads the package, give it a minute)";
  const r = await api("/api/mcp/test", { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  $("mcp-out").textContent = j.ok
    ? `✓ connected — ${j.tools.length} tools: ` + j.tools.map((t) => t.name).slice(0, 12).join(", ")
    : "✕ " + (j.error || j.detail || "failed");
};

$("mcp-add-btn").onclick = async () => {
  const body = mcpFormBody();
  if (!body.name || (!body.command && !body.url)) { $("mcp-out").textContent = "name and command or URL required"; return; }
  const r = await api("/api/mcp", { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("mcp-out").textContent = j.detail || "failed"; return; }
  $("mcp-out").textContent = "added ✓ — its tools are available in the next chat";
  $("mcp-name").value = ""; $("mcp-command").value = ""; $("mcp-args").value = ""; $("mcp-env").value = ""; $("mcp-url").value = "";
  $("mcp-command").disabled = false;
  $("mcp-args").disabled = false;
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
      const ok = await openModal({
        title: "Delete this skill?",
        text: `“${s.title}” (/${s.id}) will be removed from the server. Chats that already used it keep their history.`,
        icon: "🗑",
        danger: true,
        okLabel: "Delete skill",
        cancelLabel: "Keep it",
      });
      if (!ok) return;
      await api("/api/skills/" + s.id, { method: "DELETE" });
      loadSkillsTab();
      loadSkills();
      toast("Skill deleted");
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
let projStyleSel = null;

async function loadProjectsTab() {
  const projects = await json(await api("/api/projects"));
  const list = $("proj-list");
  list.innerHTML = projects.length ? "" : '<p class="muted small">No projects yet. Use the + next to Projects in the sidebar, add knowledge here, and every chat inside that folder gets the same context.</p>';
  for (const p of projects) {
    const item = el("div", "provider-item proj-tile");
    item.style.setProperty("--pc", projectColor(p));
    const head = el("div", "p-head");
    head.innerHTML =
      `<span class="p-ico">${esc(projectIcon(p))}</span><span class="p-name">${esc(p.name)}</span>` +
      `<span class="p-badge">${p.file_count} knowledge file${p.file_count === 1 ? "" : "s"}</span><span style="flex:1"></span>`;
    item.appendChild(head);
    const row = el("div", "row");
    const open = el("button", null, "Open");
    open.onclick = () => openProjectDetail(p.id);
    const chat = el("button", "ghost", "New chat");
    chat.onclick = () => { closeSettings(); newSession(p.id); };
    const style = el("button", "ghost", "Icon & colour");
    style.onclick = () => styleProject(p);
    const del = el("button", "ghost danger-text", "Delete");
    del.onclick = () => deleteProject(p);
    row.append(open, chat, style, del);
    item.appendChild(row);
    list.appendChild(item);
  }
  loadProjects();
}

async function openProjectDetail(id) {
  const p = await json(await api("/api/projects/" + id));
  openProject = id;
  $("proj-detail").classList.remove("hidden");
  $("proj-detail").style.setProperty("--pc", projectColor(p));
  $("proj-edit-name").value = p.name;
  $("proj-instructions").value = p.instructions || "";
  $("proj-file-out").textContent = "";
  $("proj-paste-box").classList.add("hidden");
  projStyleSel = mountStylePicker($("proj-icon-grid"), $("proj-color-row"), $("proj-preview"), p);
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
  if (!name) { $("proj-name").focus(); return; }
  const r = await api("/api/projects", { method: "POST", body: { name, icon: "📁", color: PROJECT_COLORS[0] } });
  if (!r.ok) { toast("Could not create project", { kind: "error" }); return; }
  $("proj-name").value = "";
  await loadProjectsTab();
  const p = await r.json().catch(() => ({}));
  if (p.id) openProjectDetail(p.id);
};

$("proj-save-btn").onclick = async () => {
  if (!openProject) return;
  const name = $("proj-edit-name").value.trim();
  if (!name) { $("proj-file-out").textContent = "name required"; return; }
  const r = await api("/api/projects/" + openProject, {
    method: "PUT",
    body: {
      name,
      instructions: $("proj-instructions").value,
      icon: projStyleSel ? projStyleSel.icon : "",
      color: projStyleSel ? projStyleSel.color : "",
    },
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    $("proj-file-out").textContent = j.detail || "save failed";
    return;
  }
  $("proj-file-out").textContent = "saved ✓";
  await loadProjectsTab();
  toast("Project saved");
};

$("proj-delete-btn").onclick = async () => {
  if (!openProject) return;
  const p = state.projects.find((x) => x.id === openProject);
  if (!p) return;
  await deleteProject(p);
  if (!state.projects.some((x) => x.id === openProject)) {
    openProject = null;
    $("proj-detail").classList.add("hidden");
  }
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
      "--row-tint": "rgba(255,255,255,.03)", "--code-bg": "rgba(0,0,0,.25)",
    },
  },
  midnight: {
    label: "Midnight",
    vars: {
      "--bg": "#05060f", "--bg2": "#0b0e1d", "--bg3": "#131735", "--border": "#232a52",
      "--text": "#e8eaff", "--muted": "#8f96c0", "--accent": "#7c5cff", "--accent2": "#34d399", "--accent3": "#38bdf8",
      "--glow-a": "rgba(124,92,255,.2)", "--glow-b": "rgba(56,189,248,.12)",
      "--surface-sidebar": "rgba(11,14,29,.75)", "--surface-topbar": "rgba(11,14,29,.55)", "--surface-card": "rgba(11,14,29,.92)",
      "--row-tint": "rgba(255,255,255,.04)", "--code-bg": "rgba(0,0,0,.35)",
    },
  },
  light: {
    label: "Light",
    vars: {
      "--bg": "#f5f7fb", "--bg2": "#ffffff", "--bg3": "#eef1f7", "--border": "#d8dee9",
      "--text": "#1a2233", "--muted": "#5b6577", "--accent": "#2563eb", "--accent2": "#16a34a", "--accent3": "#7c3aed",
      "--glow-a": "rgba(37,99,235,.1)", "--glow-b": "rgba(124,58,237,.08)",
      "--surface-sidebar": "rgba(255,255,255,.8)", "--surface-topbar": "rgba(255,255,255,.65)", "--surface-card": "rgba(255,255,255,.95)",
      "--row-tint": "rgba(15,23,42,.04)", "--code-bg": "rgba(15,23,42,.06)",
    },
  },
  ocean: {
    label: "Ocean",
    vars: {
      "--bg": "#04121d", "--bg2": "#082032", "--bg3": "#0d2c42", "--border": "#16405c",
      "--text": "#e2f3ff", "--muted": "#7fa8bf", "--accent": "#06b6d4", "--accent2": "#34d399", "--accent3": "#60a5fa",
      "--glow-a": "rgba(6,182,212,.16)", "--glow-b": "rgba(96,165,250,.12)",
      "--surface-sidebar": "rgba(8,32,50,.75)", "--surface-topbar": "rgba(8,32,50,.55)", "--surface-card": "rgba(8,32,50,.92)",
      "--row-tint": "rgba(255,255,255,.04)", "--code-bg": "rgba(0,0,0,.3)",
    },
  },
  forest: {
    label: "Forest",
    vars: {
      "--bg": "#07130c", "--bg2": "#0d1f14", "--bg3": "#143020", "--border": "#1e4530",
      "--text": "#e7f5ec", "--muted": "#86a896", "--accent": "#22c55e", "--accent2": "#a3e635", "--accent3": "#fbbf24",
      "--glow-a": "rgba(34,197,94,.14)", "--glow-b": "rgba(163,230,53,.1)",
      "--surface-sidebar": "rgba(13,31,20,.75)", "--surface-topbar": "rgba(13,31,20,.55)", "--surface-card": "rgba(13,31,20,.92)",
      "--row-tint": "rgba(255,255,255,.04)", "--code-bg": "rgba(0,0,0,.3)",
    },
  },
  sunset: {
    label: "Sunset",
    vars: {
      "--bg": "#170d12", "--bg2": "#22131c", "--bg3": "#301b28", "--border": "#47263a",
      "--text": "#fdeef4", "--muted": "#b58a9c", "--accent": "#fb7185", "--accent2": "#fbbf24", "--accent3": "#f472b6",
      "--glow-a": "rgba(251,113,133,.16)", "--glow-b": "rgba(244,114,182,.12)",
      "--surface-sidebar": "rgba(34,19,28,.75)", "--surface-topbar": "rgba(34,19,28,.55)", "--surface-card": "rgba(34,19,28,.92)",
      "--row-tint": "rgba(255,255,255,.04)", "--code-bg": "rgba(0,0,0,.3)",
    },
  },
};

function applyTheme() {
  const name = state.prefs.theme || "dark";
  const t = THEMES[name] || THEMES.dark;
  const root = document.documentElement;
  root.dataset.theme = name;
  const vars = Object.assign({}, t.vars);
  const accent = state.prefs.accent;
  if (accent) vars["--accent"] = accent;
  vars["--grad"] = `linear-gradient(135deg, ${vars["--accent"]} 0%, ${vars["--accent3"]} 50%, #ec4899 100%)`;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}

function renderAppearance() {
  const grid = $("theme-grid");
  grid.innerHTML = "";
  const current = state.prefs.theme || "dark";
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
      setPref("theme", name);
      renderAppearance();
      renderSessions();
    };
    grid.appendChild(card);
  }
  const t = THEMES[current] || THEMES.dark;
  $("accent-picker").value = state.prefs.accent || t.vars["--accent"];
}

$("accent-picker").oninput = (e) => setPref("accent", e.target.value);
$("accent-reset").onclick = () => {
  setPref("accent", "");
  renderAppearance();
  renderSessions();
};

/* ---------------- boot ---------------- */

(async function init() {
  document.title = "JARVIS";
  state.prefs = localPrefs();
  applyTheme();
  await boot();
  if ($("app").classList.contains("hidden")) return;
  setInterval(async () => {
    if (document.hidden) return;
    await loadJobs();
    if (state.detached && state.jobId) {
      const j = state.jobs.find((x) => x.id === state.jobId);
      if (j && j.status !== "running") {
        state.detached = false;
        await resumeJob(j.id);
      }
    }
  }, 4000);
})();