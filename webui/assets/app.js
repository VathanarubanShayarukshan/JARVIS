"use strict";

const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) => {
  const headers = Object.assign({}, opts.headers || {});
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  if (opts.body && typeof opts.body !== "string") headers["Content-Type"] = "application/json";
  const finalBody = opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body;
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
  await Promise.all([loadSessions(), loadProviders(), loadModels()]);
}

async function loadModels() {
  const m = await json(await api("/api/models"));
  document.title = "AgenticAI";
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
    item.textContent = s.title || "Untitled";
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
    inner.innerHTML = '<div class="empty-chat"><h2>AgenticAI</h2><p>Ask it to build something, fix a bug,<br>or browse the web — it has file, shell and web tools.</p></div>';
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
function makeActivity(activity) {
  const pill = document.createElement("div");
  pill.className = "act-pill";
  pill.innerHTML = '<span class="spin">⚙</span><span class="txt">working…</span>';
  activity.appendChild(pill);
  activity.classList.remove("hidden");

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

  return {
    status: (txt) => {
      if (toolbar.hidden) {
        pill.hidden = false;
        pill.querySelector(".txt").textContent = txt;
      }
    },
    dismiss: () => pill.hidden = true,
    addTool: (name) => {
      pill.hidden = false;
      pill.querySelector(".txt").textContent = "using " + name + "…";
      const row = document.createElement("div");
      row.className = "tool-row";
      row.innerHTML = `<span class="spin">⚙</span><span class="tname">${esc(name)}</span><span class="running">…</span>`;
      list.appendChild(row);
      rows.push(row);
      toolbar.hidden = false;
      toolbar.open = false;
    },
    toolDone: (name, ok) => {
      const row = rows[rows.length - 1];
      if (row) {
        const s = row.querySelector(".running");
        s.textContent = ok ? "done" : "error";
        s.className = ok ? "tstatus ok" : "tstatus err";
        row.querySelector(".spin").textContent = ok ? "✓" : "✕";
      }
      pill.hidden = true;
    },
    finish: () => {
      pill.hidden = true;
      toolbar.hidden = false;
      toolbar.open = false;
      const c = rows.length;
      summary.innerHTML = `⚙ ${c} tool call${c === 1 ? "" : "s"}` + (c ? ` <span class="hint">— tap to view</span>` : "");
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
  if (!text || !state.sessionId || state.busy) return;
  state.busy = true;
  $("send-btn").disabled = true;
  appendMsg("user").body.textContent = text;
  input.value = "";
  input.style.height = "auto";
  scrollChat();

  const userText = text;
  const { body: asBody, activity: asActivity } = appendMsg("assistant");
  uiState.activity = makeActivity(asActivity);
  uiState.answer = "";
  uiState.toolCount = 0;

  try {
    const r = await api("/api/chat", {
      method: "POST",
      body: {
        session_id: state.sessionId,
        message: userText,
        provider_id: modelProviderId(),
        model: modelId(),
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
    asBody.innerHTML = `<span class="error">Error: ${esc(e.message)}</span>`;
  } finally {
    state.busy = false;
    $("send-btn").disabled = false;
    $("input").focus();
  }
}

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
      a.addTool(ev.name);
      scrollChat();
      break;
    case "tool_result":
      a.toolDone(ev.name, !String(ev.result).startsWith("Error"));
      break;
    case "done":
      a.finish();
      if (ev.content) {
        uiState.answer = ev.content;
        asBody.innerHTML = renderMarkdown(ev.content);
      }
      if (state.autoTitle) autoTitle();
      scrollChat();
      break;
    case "error":
      a.finish();
      asBody.innerHTML = `<span class="error">${esc(ev.message)}</span>`;
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
    if (!p.api_key_set && !p.local) continue;
    const models = (Array.isArray(p.models) ? p.models : []).slice(0, 300);
    if (!models.length) continue;
    const og = document.createElement("optgroup");
    og.label = p.name + (p.local ? " (local)" : "");
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

/* ---------------- settings modal ---------------- */

$("settings-btn").onclick = openSettings;
$("settings-close").onclick = () => $("settings-modal").classList.add("hidden");
document.querySelectorAll(".tab").forEach((t) =>
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    $("tab-" + t.dataset.tab).classList.remove("hidden");
    if (t.dataset.tab === "files") loadFileTree();
  }
);

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
    const badge = p.is_custom ? "" : `<span class="p-badge">built-in</span>`;
    item.innerHTML =
      `<div class="p-head"><span class="p-name">${esc(p.name)}</span>${badge}` +
      (p.local ? `<span class="p-badge">local</span>` : "") +
      `<span class="p-key">${p.api_key_set ? "✓ key set" : "no key"}</span>` +
      `<span style="flex:1"></span></div>`;
    item.innerHTML +=
      `<div class="api-key-row"><input type="password" placeholder="API key (free tier)" value="">` +
      `<button class="save-key">Set key</button>` +
      (p.is_custom ? `<button class="remove">Delete</button>` : "") + `</div>`;
    if (p.hint) item.innerHTML += `<p class="p-hint">${esc(p.hint)}</p>`;
    const allModels = p.models || [];
    const models = allModels.slice(0, 40);
    const more = allModels.length > 40
      ? `<span class="model-pill">+${allModels.length - 40} more</span>`
      : "";
    item.innerHTML += `<div class="p-models">` +
      models.map((m) => `<span class="model-pill">${esc(m)}</span>`).join("") +
      more + `</div>`;
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
    node.innerHTML = `<span class="indent" style="width:${depth * 14}px"></span>📁 ${esc(e.name)}`;
    if (e.type === "file") node.innerHTML = `<span class="indent" style="width:${depth * 14}px"></span>📄 ${esc(e.name)}`;
    node.onclick = async () => {
      document.querySelectorAll(".file-node").forEach((n) => n.classList.remove("selected"));
      node.classList.add("selected");
      if (e.type === "dir") {
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
        $("file-content").value = fj.content || "";
      }
    };
    container.appendChild(node);
  }
}

$("file-save").onclick = async () => {
  await api("/api/files/write", {
    method: "POST",
    body: { path: $("file-save").dataset.path, content: $("file-content").value },
  });
};

/* ---------------- boot ---------------- */

(async function init() {
  document.title = "AgenticAI";
  const saved = localStorage.getItem("session");
  await boot();
  if (state.token) {
    if (saved && state.sessions.some((s) => s.id === saved)) await selectSession(saved);
    else await newSession();
  }
})();