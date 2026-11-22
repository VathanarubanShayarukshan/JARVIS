// Full UI regression suite over Chrome DevTools Protocol.
// Prereq: app on :8001 (DATA_DIR=data-test OPEN_ACCESS=1), stub :9500, slow stub :9504,
// chrome --headless=new --remote-debugging-port=9222 --user-data-dir=data-test/chrome-profile
// Run: node scripts/ui_check.mjs

import fs from "node:fs";
import path from "node:path";

const APP = "http://127.0.0.1:8001";
const OUT = path.resolve("data-test/ui-shots");
fs.mkdirSync(OUT, { recursive: true });

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0;
const pending = new Map();
const consoleErrors = [];
const dialogs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Page.javascriptDialogOpening") {
    dialogs.push((m.params.type || "?") + ": " + (m.params.message || ""));
    send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "exception");
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++mid;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64"));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (expr, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expr)) return true;
    await sleep(150);
  }
  return false;
};
const results = [];
const check = (name, ok, extra = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`);
  if (!ok) process.exitCode = 1;
};
const metrics = (width, height, mobile) =>
  send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");

// in-page helpers
const HELPERS = `
window.__type = (v, caret) => {
  const i = document.getElementById("input");
  i.value = v;
  const c = caret == null ? v.length : caret;
  i.setSelectionRange(c, c);
  i.dispatchEvent(new Event("input"));
};
window.__drag = (srcSel, dstSel) => {
  const src = document.querySelector(srcSel), dst = document.querySelector(dstSel);
  if (!src || !dst) return "missing node";
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  src.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
  return "ok";
};
window.__menuItem = (label) => {
  const b = [...document.querySelectorAll("#ctx-menu .ctx-item")].find((x) => x.textContent.includes(label));
  if (!b) return false;
  b.click();
  return true;
};
window.__rowMenu = () => {
  const b = document.querySelector(".session-item.active .row-menu");
  if (!b) return false;
  b.click();
  return true;
};
window.__modalOpen = () => !document.getElementById("modal-root").classList.contains("hidden");
window.__menuOpen = () => !document.getElementById("ctx-menu").classList.contains("hidden");
window.__paletteOpen = () => !document.getElementById("cmd-palette").classList.contains("hidden");
window.__modalInput = (v) => {
  const i = document.querySelector("#modal-body input, #modal-body textarea");
  if (!i) return false;
  i.value = v;
  i.dispatchEvent(new Event("input"));
  return true;
};
window.__newChat = async () => {
  const prev = state.sessionId;
  document.getElementById("new-chat-btn").click();
  for (let i = 0; i < 100 && state.sessionId === prev; i++) await new Promise((r) => setTimeout(r, 40));
  return state.sessionId;
};
window.__pickModel = async (suffix) => {
  const sel = document.getElementById("model-select");
  const opt = [...sel.options].find((o) => o.value.endsWith(suffix));
  if (!opt) return null;
  sel.value = opt.value;
  sel.dispatchEvent(new Event("change"));
  return opt.value;
};
window.__send = async (text) => {
  window.__type(text);
  document.getElementById("send-btn").click();
  for (let i = 0; i < 100 && !state.busy; i++) await new Promise((r) => setTimeout(r, 40));
  return state.busy;
};
window.__idle = async (ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && state.busy) await new Promise((r) => setTimeout(r, 100));
  return !state.busy;
};
window.__prefs = async () => await json(await api("/api/preferences"));
window.__jobs = async () => await json(await api("/api/jobs"));
true`;

// ---------- boot ----------
await metrics(1440, 900, false);
await send("Page.navigate", { url: APP });
await until(`!document.getElementById("app").classList.contains("hidden") || !document.getElementById("login-screen").classList.contains("hidden")`);
if (await ev(`!document.getElementById("login-screen").classList.contains("hidden")`)) {
  await ev(`(() => { document.getElementById("login-password").value = "test-pass"; document.getElementById("login-btn").click(); })()`);
}
check("boot: login enters app", await until(`!document.getElementById("app").classList.contains("hidden")`, 15000));
await until(`state.sessions.length > 0 && state.projects.length >= 0 && state.skills.length > 0`, 10000);
await ev(HELPERS);
await sleep(500);
const startPrefs = await ev(`window.__prefs()`);

// ---------- topbar / sidebar shape ----------
const t1 = await ev(`JSON.stringify({
  projSelect: !!document.getElementById("project-select"),
  skillSelect: !!document.getElementById("skill-select"),
  autoTitle: !!document.getElementById("auto-title"),
  topbarSwitches: document.querySelectorAll(".topbar .switch-pill").length,
  titleBtn: !!document.getElementById("chat-title-btn"),
  sync: !!document.getElementById("sync-pill"),
  addBtn: !!document.querySelector(".projects-label .label-add"),
  folders: document.querySelectorAll(".proj-folder").length,
  kids: document.querySelectorAll(".folder-kids .session-item").length,
  active: document.querySelectorAll(".session-item.active").length,
  menu: getComputedStyle(document.getElementById("menu-btn")).display,
  pos: getComputedStyle(document.querySelector(".sidebar")).position,
  togglesInSettings: !!document.getElementById("toggle-thinking") && !!document.getElementById("toggle-toollog"),
  chatTab: !!document.querySelector('.set-item[data-tab="chat"]')
})`);
const t1o = JSON.parse(t1);
check("topbar: project + skill selectors and auto-title box removed",
  !t1o.projSelect && !t1o.skillSelect && !t1o.autoTitle && t1o.topbarSwitches === 0, t1);
check("topbar: rename title button + server sync pill", t1o.titleBtn && t1o.sync, t1);
check("sidebar: Projects + button, folders with chats, one active row",
  t1o.addBtn && t1o.folders >= 1 && t1o.kids >= 1 && t1o.active === 1, t1);
check("desktop: hamburger hidden, sidebar inline", t1o.menu === "none" && t1o.pos === "static", t1);
check("settings: thinking/tool-log toggles live in Chat & logs tab", t1o.togglesInSettings && t1o.chatTab, t1);

const d2 = await ev(`(async () => {
  const head = document.querySelector(".proj-folder .folder-head");
  const folder = head.closest(".proj-folder");
  const pid = folder.dataset.project;
  const had = !!folder.querySelector(".folder-kids");
  head.click();
  const collapsedNow = !document.querySelector('.proj-folder[data-project="' + pid + '"] .folder-kids');
  await new Promise(r => setTimeout(r, 600));
  const prefs = await window.__prefs();
  const stored = (prefs.collapsedProjects || []).includes(pid);
  document.querySelector('.proj-folder[data-project="' + pid + '"] .folder-head').click();
  await new Promise(r => setTimeout(r, 600));
  const reopened = !!document.querySelector('.proj-folder[data-project="' + pid + '"] .folder-kids');
  const prefs2 = await window.__prefs();
  return JSON.stringify({ had, collapsedNow, stored, reopened, cleared: !(prefs2.collapsedProjects || []).includes(pid) });
})()`);
const d2o = JSON.parse(d2);
check("sidebar: folder collapse/expand persisted on the SERVER",
  d2o.had && d2o.collapsedNow && d2o.stored && d2o.reopened && d2o.cleared, d2);

const d4 = await ev(`JSON.stringify({
  doc: document.documentElement.scrollWidth <= window.innerWidth + 1,
  topbar: document.querySelector(".topbar").scrollWidth <= document.querySelector(".topbar").clientWidth + 1,
  composer: document.querySelector(".composer-input-row").scrollWidth <= document.querySelector(".composer-input-row").clientWidth + 1
})`);
const d4o = JSON.parse(d4);
check("desktop: no horizontal overflow", d4o.doc && d4o.topbar && d4o.composer, d4);
await shot("01-desktop.png");

// ---------- project create with icon + colour ----------
const PROJ = "UI Test " + Date.now().toString().slice(-5);
await ev(`document.querySelector(".projects-label .label-add").click()`);
check("project: + opens create modal", await until(`window.__modalOpen()`));
await ev(`window.__modalInput(${JSON.stringify(PROJ)})`);
await ev(`document.querySelectorAll("#modal-body .icon-cell")[1].click()`);
await ev(`document.querySelectorAll("#modal-body .swatch")[2].click()`);
const picked = await ev(`JSON.stringify({
  icon: document.querySelectorAll("#modal-body .icon-cell")[1].dataset.icon,
  color: document.querySelectorAll("#modal-body .swatch")[2].dataset.color,
  preview: document.getElementById("proj-preview") ? null : document.querySelector("#modal-body .proj-preview").textContent
})`);
const pickedO = JSON.parse(picked);
await shot("02-project-create.png");
await ev(`document.getElementById("modal-ok").click()`);
check("project: create modal closes", await until(`!window.__modalOpen()`));
await until(`state.projects.some(p => p.name === ${JSON.stringify(PROJ)})`);
const pid = await ev(`(state.projects.find(p => p.name === ${JSON.stringify(PROJ)}) || {}).id`);
const p1 = await ev(`(async () => {
  const p = state.projects.find(x => x.id === ${JSON.stringify(pid)});
  const f = document.querySelector('.proj-folder[data-project="' + p.id + '"]');
  const ico = f && f.querySelector(".fold-ico");
  return JSON.stringify({
    icon: p.icon, color: p.color,
    domIcon: ico ? ico.textContent : null,
    domColor: f ? getComputedStyle(f).getPropertyValue("--pc").trim() : null,
    server: (await (await api("/api/projects/" + p.id)).json()).color
  });
})()`);
const p1o = JSON.parse(p1);
check("project: created with chosen icon + colour (DB, state and sidebar)",
  p1o.icon === pickedO.icon && p1o.color === pickedO.color && p1o.domIcon === pickedO.icon &&
  p1o.domColor === pickedO.color && p1o.server === pickedO.color, p1);

// empty-name validation
await ev(`document.querySelector(".projects-label .label-add").click()`);
await until(`window.__modalOpen()`);
await ev(`document.getElementById("modal-ok").click()`);
await sleep(250);
check("project: empty name blocked with inline error",
  await ev(`window.__modalOpen() && !document.getElementById("modal-err").classList.contains("hidden")`));
await ev(`document.getElementById("modal-cancel").click()`);
await until(`!window.__modalOpen()`);

// ---------- project rename + restyle ----------
await ev(`document.querySelector('.proj-folder[data-project="${pid}"] .row-menu').click()`);
check("project: kebab menu opens", await until(`window.__menuOpen()`));
await shot("03-project-menu.png");
check("project: menu offers new chat / rename / style / knowledge / delete", await ev(`JSON.stringify(
  ["New chat here","Rename project","Icon & colour","Instructions & knowledge","Delete project"]
    .every(l => [...document.querySelectorAll("#ctx-menu .ctx-item")].some(b => b.textContent.includes(l)))
)`));
await ev(`window.__menuItem("Rename project")`);
await until(`window.__modalOpen()`);
await ev(`window.__modalInput(${JSON.stringify(PROJ + " R")})`);
await ev(`document.getElementById("modal-ok").click()`);
await until(`!window.__modalOpen()`);
check("project: rename lands in sidebar + server", await until(`(async () => {
  const p = (await (await api("/api/projects")).json()).find(x => x.id === ${JSON.stringify(pid)});
  const f = document.querySelector('.proj-folder[data-project="' + ${JSON.stringify(pid)} + '"] .folder-name');
  return p && p.name === ${JSON.stringify(PROJ + " R")} && f && f.textContent === p.name;
})()`));

await ev(`document.querySelector('.proj-folder[data-project="${pid}"] .row-menu').click()`);
await until(`window.__menuOpen()`);
await ev(`window.__menuItem("Icon & colour")`);
await until(`window.__modalOpen()`);
await ev(`document.querySelectorAll("#modal-body .icon-cell")[4].click()`);
await ev(`document.querySelectorAll("#modal-body .swatch")[5].click()`);
const restyle = await ev(`JSON.stringify({
  icon: document.querySelectorAll("#modal-body .icon-cell")[4].dataset.icon,
  color: document.querySelectorAll("#modal-body .swatch")[5].dataset.color
})`);
const restyleO = JSON.parse(restyle);
await shot("04-project-style.png");
await ev(`document.getElementById("modal-ok").click()`);
await until(`!window.__modalOpen()`);
check("project: icon + colour change persists", await until(`(async () => {
  const p = (await (await api("/api/projects")).json()).find(x => x.id === ${JSON.stringify(pid)});
  const ico = document.querySelector('.proj-folder[data-project="' + ${JSON.stringify(pid)} + '"] .fold-ico');
  return p && p.icon === ${JSON.stringify(restyleO.icon)} && p.color === ${JSON.stringify(restyleO.color)} && ico.textContent === p.icon;
})()`));

// ---------- chat rename ----------
await ev(`window.__newChat()`);
await sleep(400);
const chatId = await ev(`state.sessionId`);
await ev(`document.getElementById("chat-title-btn").click()`);
check("chat: title button opens rename modal", await until(`window.__modalOpen()`));
await ev(`window.__modalInput("Renamed by UI test")`);
await shot("05-chat-rename.png");
await ev(`document.getElementById("modal-ok").click()`);
await until(`!window.__modalOpen()`);
check("chat: rename updates topbar, sidebar and server", await until(`(async () => {
  const s = (await (await api("/api/sessions")).json()).find(x => x.id === ${JSON.stringify(chatId)});
  const row = document.querySelector('.session-item.active .session-title');
  return s && s.title === "Renamed by UI test" &&
    document.getElementById("chat-title").textContent === s.title && row && row.textContent === s.title;
})()`));

// ---------- move chat into project (menu) + undo ----------
await ev(`window.__rowMenu()`);
await until(`window.__menuOpen()`);
await shot("06-chat-menu.png");
await ev(`window.__menuItem("Move to project")`);
await sleep(200);
check("chat: move submenu lists projects + No project + New project", await ev(`JSON.stringify(
  ["No project","New project"].every(l => [...document.querySelectorAll("#ctx-menu .ctx-item")].some(b => b.textContent.includes(l)))
  && [...document.querySelectorAll("#ctx-menu .ctx-item")].some(b => b.textContent.includes(${JSON.stringify(PROJ + " R")}))
)`));
await ev(`window.__menuItem(${JSON.stringify(PROJ + " R")})`);
check("chat: moved into project folder", await until(`(async () => {
  const s = state.sessions.find(x => x.id === ${JSON.stringify(chatId)});
  const row = document.querySelector('.session-item.active');
  const chip = document.getElementById("proj-chip");
  return s && s.project_id === ${JSON.stringify(pid)} && row && !!row.closest('.proj-folder[data-project="' + ${JSON.stringify(pid)} + '"]')
    && !chip.classList.contains("hidden") && chip.textContent.includes(${JSON.stringify(PROJ + " R")});
})()`));
check("chat: move shows Undo toast", await until(`!!document.querySelector("#toasts .toast-act")`));
check("toasts: never cover the composer", await ev(`(() => {
  const t = document.querySelector("#toasts .toast");
  if (!t) return false;
  const r = t.getBoundingClientRect();
  const c = document.querySelector(".composer-shell").getBoundingClientRect();
  return r.right < c.left || r.left > c.right || r.bottom < c.top || r.top > c.bottom;
})()`));
await shot("07-chat-moved.png");
await ev(`document.querySelector("#toasts .toast-act").click()`);
check("chat: Undo returns it to loose chats", await until(`(async () => {
  const s = (await (await api("/api/sessions")).json()).find(x => x.id === ${JSON.stringify(chatId)});
  return s && !s.project_id && !document.querySelector('.session-item.active').closest(".proj-folder");
})()`));

// ---------- drag and drop ----------
const dragRes = await ev(`window.__drag('.session-item.active', '.proj-folder[data-project="${pid}"]')`);
check("chat: drag onto folder moves it (server too)", dragRes === "ok" && await until(`(async () => {
  const s = (await (await api("/api/sessions")).json()).find(x => x.id === ${JSON.stringify(chatId)});
  return s && s.project_id === ${JSON.stringify(pid)};
})()`), String(dragRes));
const drag2Res = await ev(`window.__drag('.session-item.active', '.loose-box')`);
const drag2Ok = await until(`(async () => {
  const s = (await (await api("/api/sessions")).json()).find(x => x.id === ${JSON.stringify(chatId)});
  return s && !s.project_id;
})()`);
check("chat: drag onto Chats removes it from the project", drag2Ok, drag2Ok ? "" : await ev(`(async () => {
  const s = (await (await api("/api/sessions")).json()).find(x => x.id === ${JSON.stringify(chatId)});
  return JSON.stringify({ ret: ${JSON.stringify(drag2Res)}, server: s && s.project_id,
    state: (state.sessions.find(x => x.id === ${JSON.stringify(chatId)}) || {}).project_id,
    dragId: state.dragId, active: !!document.querySelector(".session-item.active"),
    loose: !!document.querySelector(".loose-box") });
})()`));

// ---------- delete chat: confirmation ----------
await ev(`window.__rowMenu()`);
await until(`window.__menuOpen()`);
await ev(`window.__menuItem("Delete chat")`);
check("chat: delete asks for confirmation first", await until(`window.__modalOpen() && document.getElementById("modal-card").classList.contains("danger")`));
const delText = await ev(`document.getElementById("modal-title").textContent + " | " + document.getElementById("modal-text").textContent`);
check("chat: confirmation names the chat and warns it is permanent",
  /Delete this chat\?/.test(delText) && /Renamed by UI test/.test(delText) && /cannot be undone/i.test(delText), delText);
await shot("08-delete-confirm.png");
await ev(`document.getElementById("modal-cancel").click()`);
await until(`!window.__modalOpen()`);
check("chat: cancel keeps the chat", await ev(`state.sessions.some(s => s.id === ${JSON.stringify(chatId)})`));
await ev(`window.__rowMenu()`);
await until(`window.__menuOpen()`);
await ev(`window.__menuItem("Delete chat")`);
await until(`window.__modalOpen()`);
await ev(`document.getElementById("modal-ok").click()`);
check("chat: confirm deletes it everywhere", await until(`(async () => {
  const gone = !(await (await api("/api/sessions")).json()).some(x => x.id === ${JSON.stringify(chatId)});
  return gone && !state.sessions.some(x => x.id === ${JSON.stringify(chatId)}) && !document.querySelector('.session-item[data-id="' + ${JSON.stringify(chatId)} + '"]');
})()`));
check("chat: Escape closes the modal without deleting", await ev(`(async () => {
  const before = state.sessions.length;
  window.__rowMenu();
  await new Promise(r => setTimeout(r, 200));
  window.__menuItem("Delete chat");
  await new Promise(r => setTimeout(r, 250));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  return !window.__modalOpen() && state.sessions.length === before;
})()`));

// ---------- composer: / skills palette ----------
await ev(`window.__newChat()`);
await sleep(300);
await ev(`window.__type("/")`);
check("composer: / opens the skills palette", await until(`window.__paletteOpen() && document.getElementById("cmd-kind").textContent === "Skills"`));
const skillList = await ev(`JSON.stringify([...document.querySelectorAll("#cmd-list .cmd-item b")].map(b => b.textContent))`);
check("composer: palette lists real skills", JSON.parse(skillList).includes("/code-review"), skillList);
await sleep(300);
await shot("09-slash-palette.png");
await ev(`window.__type("/code-r")`);
await sleep(200);
check("composer: typing filters the palette", await ev(`document.querySelectorAll("#cmd-list .cmd-item").length === 1 && document.querySelector("#cmd-list .cmd-item b").textContent === "/code-review"`));
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(250);
check("composer: Enter inserts the skill and closes the palette",
  await ev(`document.getElementById("input").value === "/code-review " && !window.__paletteOpen()`),
  await ev(`document.getElementById("input").value`));
check("composer: skill chip appears", await ev(`document.querySelectorAll("#cmd-chips .cmd-chip.skill").length === 1`));

// ---------- composer: @ MCP palette ----------
await ev(`window.__type("/code-review @")`);
check("composer: @ opens the MCP palette", await until(`window.__paletteOpen() && document.getElementById("cmd-kind").textContent === "MCP servers"`));
const mcpList = await ev(`JSON.stringify([...document.querySelectorAll("#cmd-list .cmd-item b")].map(b => b.textContent))`);
check("composer: palette lists connected MCP servers", JSON.parse(mcpList).some((x) => x.toLowerCase() === "@echo"), mcpList);
await sleep(300);
await shot("10-at-palette.png");
await ev(`window.__type("/code-review @Ec")`);
await sleep(200);
await ev(`document.querySelector("#cmd-list .cmd-item").click()`);
await sleep(250);
check("composer: click inserts the mention", await ev(`document.getElementById("input").value === "/code-review @Echo "`),
  await ev(`document.getElementById("input").value`));
check("composer: both chips shown", await ev(`document.querySelectorAll("#cmd-chips .cmd-chip").length === 2`));
await ev(`document.querySelector("#cmd-chips .cmd-chip.mcp .cmd-chip-x").click()`);
await sleep(200);
check("composer: chip ✕ removes the mention from the text",
  await ev(`document.getElementById("input").value === "/code-review " && document.querySelectorAll("#cmd-chips .cmd-chip").length === 1`),
  await ev(`document.getElementById("input").value`));
await ev(`window.__type("/code-review @Echo ")`);
await ev(`document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
check("composer: Escape dismisses the palette but keeps the text",
  await ev(`!window.__paletteOpen() && document.getElementById("input").value.includes("@Echo")`));
check("composer: hint buttons insert triggers", await ev(`(async () => {
  window.__type("");
  document.getElementById("slash-hint").click();
  const a = document.getElementById("input").value;
  window.__type("");
  document.getElementById("at-hint").click();
  const b = document.getElementById("input").value;
  return a === "/" && b === "@";
})()`));

// ---------- send: auto title + skill/MCP actually reach the model ----------
const stubModel = await ev(`window.__pickModel("|stub-1")`);
check("send: stub model selected", !!stubModel, String(stubModel));
const logBefore = fs.existsSync("stub_requests.jsonl") ? fs.readFileSync("stub_requests.jsonl", "utf8").trim().split("\n").length : 0;
await ev(`window.__send("/code-review @Echo write hello.txt please")`);
check("send: reaches the model and finishes", await ev(`window.__idle(25000)`));
await sleep(600);
const sent = await ev(`(async () => {
  const s = (await (await api("/api/sessions")).json()).find(x => x.id === state.sessionId);
  return JSON.stringify({
    title: s && s.title,
    topbar: document.getElementById("chat-title").textContent,
    answer: document.getElementById("chat").innerText.includes("I created the file"),
    outFile: !!document.querySelector(".out-files .att-chip"),
    noCheckbox: !document.getElementById("auto-title")
  });
})()`);
const sentO = JSON.parse(sent);
check("send: chat auto-named from the message (commands stripped)",
  sentO.title === "write hello.txt please" && sentO.topbar === sentO.title && sentO.noCheckbox, sent);
check("send: tool ran, answer + output file chip rendered", sentO.answer && sentO.outFile, sent);
const lines = fs.readFileSync("stub_requests.jsonl", "utf8").trim().split("\n").slice(logBefore);
const payload = lines.map((l) => JSON.parse(l));
const sysJoined = payload.map((p) => (p.messages.find((m) => m.role === "system") || {}).content || "").join("\n");
const userJoined = payload.map((p) => (p.messages.find((m) => m.role === "user") || {}).content || "").join("\n");
check("send: /skill injected into the task server-side", userJoined.includes("# Skill: code-review"), userJoined.slice(0, 120));
check("send: @mcp injected into the system prompt server-side", sysJoined.includes("mcp__Echo__"), sysJoined.slice(-200));
await shot("11-stub-answer.png");

// ---------- settings: chat & logs, stored on the server ----------
await ev(`document.getElementById("settings-btn").click()`);
await ev(`document.querySelector('.set-item[data-tab="chat"]').click()`);
await sleep(300);
check("settings: Chat & logs tab shows both switches + command help", await ev(`JSON.stringify({
  panel: !document.getElementById("tab-chat").classList.contains("hidden"),
  think: !!document.getElementById("toggle-thinking"),
  tool: !!document.getElementById("toggle-toollog"),
  help: document.querySelectorAll("#tab-chat .cmd-help-row").length
})`).then((s) => { const o = JSON.parse(s); return o.panel && o.think && o.tool && o.help >= 4; }));
await shot("12-settings-chat.png");
await ev(`(async () => { await api("/api/preferences", { method: "PUT", body: { showThinking: true, showToolLog: true } }); await loadPrefs(); })()`);
await sleep(400);
check("settings: server prefs drive the switches on open",
  await ev(`document.getElementById("toggle-thinking").checked && document.getElementById("toggle-toollog").checked && !document.body.classList.contains("hide-thinking")`));
await ev(`document.getElementById("toggle-thinking").closest(".switch-row").click()`);
await sleep(700);
const tog1 = await ev(`(async () => JSON.stringify({
  body: document.body.classList.contains("hide-thinking"),
  server: (await window.__prefs()).showThinking,
  pill: document.getElementById("sync-pill").dataset.mode
}))()`);
const tog1o = JSON.parse(tog1);
check("settings: thinking toggle applies instantly and saves to server",
  tog1o.body === true && tog1o.server === false && tog1o.pill === "synced", tog1);
await ev(`document.getElementById("toggle-toollog").closest(".switch-row").click()`);
await sleep(700);
check("settings: tool-log toggle saves to server",
  await ev(`(async () => (await window.__prefs()).showToolLog === false && document.body.classList.contains("hide-toollog"))()`));
await send("Page.reload");
await until(`!document.getElementById("app").classList.contains("hidden")`, 15000);
await ev(HELPERS);
await sleep(900);
check("settings: toggles survive reload on a fresh page (multi-device)", await ev(`JSON.stringify({
  think: document.getElementById("toggle-thinking").checked,
  tool: document.getElementById("toggle-toollog").checked,
  body: document.body.classList.contains("hide-thinking") && document.body.classList.contains("hide-toollog")
})`).then((s) => { const o = JSON.parse(s); return !o.think && !o.tool && o.body; }));
await ev(`document.getElementById("settings-btn").click()`);
await ev(`document.querySelector('.set-item[data-tab="chat"]').click()`);
await ev(`document.getElementById("toggle-thinking").closest(".switch-row").click()`);
await ev(`document.getElementById("toggle-toollog").closest(".switch-row").click()`);
await sleep(800);
check("settings: restored both toggles on the server",
  await ev(`(async () => { const p = await window.__prefs(); return p.showThinking === true && p.showToolLog === true; })()`));

// ---------- settings: appearance persists ----------
await ev(`document.querySelector('.set-item[data-tab="appearance"]').click()`);
await sleep(250);
await ev(`document.querySelectorAll("#theme-grid .theme-card")[3].click()`);
await sleep(700);
const themeName = await ev(`document.documentElement.dataset.theme`);
check("settings: theme choice saved on the server",
  await ev(`(async () => (await window.__prefs()).theme === ${JSON.stringify(themeName)})()`), themeName);
await shot("13-theme.png");
await ev(`document.getElementById("settings-close").click()`);
await send("Page.reload");
await until(`!document.getElementById("app").classList.contains("hidden")`, 15000);
await ev(HELPERS);
await sleep(900);
check("settings: theme survives reload", await ev(`document.documentElement.dataset.theme === ${JSON.stringify(themeName)}`));
await ev(`(async () => { await api("/api/preferences", { method: "PUT", body: { theme: ${JSON.stringify(startPrefs.theme || "dark")} } }); await loadPrefs(); })()`);
await sleep(400);

// ---------- settings: project detail picker ----------
await ev(`document.getElementById("settings-btn").click()`);
await ev(`document.querySelector('.set-item[data-tab="projects"]').click()`);
await sleep(500);
check("settings: project tiles show icon, colour, knowledge count", await ev(`JSON.stringify({
  tiles: document.querySelectorAll("#proj-list .proj-tile").length,
  ico: !!document.querySelector("#proj-list .p-ico"),
  buttons: [...document.querySelectorAll("#proj-list .proj-tile .row button")].map(b => b.textContent)
})`).then((s) => { const o = JSON.parse(s); return o.tiles >= 1 && o.ico && o.buttons.includes("Icon & colour") && o.buttons.includes("Delete"); }));
await ev(`[...document.querySelectorAll("#proj-list .proj-tile")].find(t => t.textContent.includes(${JSON.stringify(PROJ + " R")})).querySelector("button").click()`);
await sleep(500);
check("settings: project detail has icon grid + colour swatches wired", await ev(`JSON.stringify({
  open: !document.getElementById("proj-detail").classList.contains("hidden"),
  icons: document.querySelectorAll("#proj-icon-grid .icon-cell").length,
  swatches: document.querySelectorAll("#proj-color-row .swatch").length,
  custom: !!document.querySelector("#proj-color-row .swatch-custom"),
  on: document.querySelectorAll("#proj-icon-grid .icon-cell.on").length
})`).then((s) => { const o = JSON.parse(s); return o.open && o.icons >= 20 && o.swatches >= 8 && o.custom && o.on === 1; }));
await shot("14-project-detail.png");
await ev(`document.querySelectorAll("#proj-icon-grid .icon-cell")[9].click()`);
await ev(`document.getElementById("proj-save-btn").click()`);
await sleep(800);
check("settings: saving detail keeps the new icon", await until(`(async () => {
  const p = (await (await api("/api/projects")).json()).find(x => x.id === ${JSON.stringify(pid)});
  return p && p.icon === document.querySelectorAll("#proj-icon-grid .icon-cell")[9].dataset.icon;
})()`));

// ---------- delete project: confirmation, chats survive ----------
await ev(`window.__newChat()`);
await sleep(300);
const orphanId = await ev(`state.sessionId`);
await ev(`(async () => { await api("/api/sessions/" + ${JSON.stringify(orphanId)} + "/project", { method: "POST", body: { project_id: ${JSON.stringify(pid)} } }); await loadSessions(); })()`);
await sleep(400);
await ev(`document.getElementById("settings-close").click()`);
await ev(`document.querySelector('.proj-folder[data-project="${pid}"] .row-menu').click()`);
await until(`window.__menuOpen()`);
await ev(`window.__menuItem("Delete project")`);
check("project: delete asks for confirmation and explains chats are kept",
  await until(`window.__modalOpen() && document.getElementById("modal-card").classList.contains("danger") && /history is kept/i.test(document.getElementById("modal-text").textContent)`),
  await ev(`document.getElementById("modal-text").textContent`));
await shot("15-project-delete.png");
await ev(`document.getElementById("modal-ok").click()`);
check("project: deleted, its chat falls back to Chats with history", await until(`(async () => {
  const gone = !(await (await api("/api/projects")).json()).some(x => x.id === ${JSON.stringify(pid)});
  const s = (await (await api("/api/sessions")).json()).find(x => x.id === ${JSON.stringify(orphanId)});
  return gone && s && !s.project_id && !document.querySelector('.proj-folder[data-project="' + ${JSON.stringify(pid)} + '"]');
})()`));

// ---------- enter sends, stop button guards the run ----------
await ev(`window.__newChat()`);
await sleep(300);
await ev(`window.__pickModel("|slow-6")`);
await ev(`window.__type("enter key sends this")`);
await ev(`document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
check("enter: Enter sends the message and clears the composer",
  await until(`state.busy && !document.getElementById("input").value && document.getElementById("chat").innerText.includes("enter key sends this")`, 8000));
check("enter: send button becomes stop while the task runs",
  await ev(`document.getElementById("send-btn").textContent === "⏹" && !document.getElementById("push-btn").classList.contains("hidden")`));
await ev(`document.getElementById("send-btn").click()`);
check("enter: stop frees the composer again", await until(`!state.busy && document.getElementById("send-btn").textContent !== "⏹"`, 8000));

// ---------- stop cancels the AI process itself ----------
const slowModel = await ev(`window.__pickModel("|slow-6")`);
check("stop: slow model selected", !!slowModel, String(slowModel));
await ev(`window.__newChat()`);
await sleep(300);
await ev(`window.__pickModel("|slow-6")`);
await ev(`window.__send("stop the agent itself")`);
check("stop: job running before stop", await until(`state.busy && !!state.jobId`, 8000));
const stopJob = await ev(`state.jobId`);
await ev(`document.getElementById("send-btn").click()`);
check("stop: server job status becomes stopped", await until(`(async () => {
  const j = (await window.__jobs()).find(x => x.id === ${JSON.stringify(stopJob)});
  return j && j.status === "stopped";
})()`, 8000));
await sleep(4500);
const afterStop = await ev(`(async () => {
  const j = (await window.__jobs()).find(x => x.id === ${JSON.stringify(stopJob)});
  return JSON.stringify({ status: j && j.status, busy: state.busy, finished: document.getElementById("chat").innerText.includes("slow work finished") });
})()`);
const afterStopO = JSON.parse(afterStop);
check("stop: agent never finishes after stop (not just the UI)",
  afterStopO.status === "stopped" && !afterStopO.busy && !afterStopO.finished, afterStop);
await shot("16-stopped.png");

// ---------- push + background survival ----------
await ev(`window.__newChat()`);
await sleep(300);
await ev(`window.__pickModel("|slow-6")`);
await ev(`window.__send("background push test")`);
check("push: button appears while running", await until(`state.busy && !!state.jobId && !document.getElementById("push-btn").classList.contains("hidden")`, 8000));
await ev(`document.getElementById("push-btn").click()`);
await sleep(250);
const p2 = await ev(`JSON.stringify({
  banner: !document.getElementById("bg-banner").classList.contains("hidden"),
  detached: state.detached,
  busy: state.busy
})`);
const p2o = JSON.parse(p2);
check("push: banner shows immediately, UI freed, job still alive", p2o.banner && p2o.detached && !p2o.busy, p2);
await shot("17-push-banner.png");
const pushedJob = await ev(`document.getElementById("bg-banner").dataset.job || state.jobId`);
check("push: pill keeps showing live progress while detached", await until(`(() => {
  const pills = [...document.querySelectorAll("#chat .act-txt")];
  const t = pills.length ? pills[pills.length - 1].textContent : "";
  return /background/i.test(t) && /·/.test(t);
})()`, 12000));
await shot("17a-push-live-progress.png");
check("push: job finishes server-side after push", await until(`(async () => {
  const j = (await window.__jobs()).find(x => x.id === ${JSON.stringify(String(pushedJob))});
  return j && j.status === "done";
})()`, 20000));
await ev(`document.getElementById("bg-resume").click()`);
await sleep(1200);
check("push: resume replays finished output", await ev(`document.getElementById("chat").innerText.includes("slow work finished")`));

// close window mid-run WITHOUT push
await ev(`window.__newChat()`);
await sleep(300);
await ev(`window.__pickModel("|slow-6")`);
await ev(`window.__send("survive window close")`);
await until(`state.busy && !!state.jobId`, 8000);
const surviveId = await ev(`state.jobId`);
check("survive: job running before reload", !!surviveId, String(surviveId));
check("survive: tab close is blocked while a task was never pushed", await ev(`(() => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
})()`));
check("survive: staying offers run-in-background or stay in tab", await until(`window.__modalOpen()
  && /background/i.test(document.getElementById("modal-ok").textContent)
  && /stay/i.test(document.getElementById("modal-cancel").textContent)`, 3000));
await shot("17b-leave-choice.png");
await ev(`document.getElementById("modal-cancel").click()`);
await sleep(200);
check("survive: staying keeps watching the task live", await ev(`!window.__modalOpen() && state.busy && !state.detached`));
await send("Page.reload");
check("survive: app boots after reload", await until(`!document.getElementById("app").classList.contains("hidden")`, 15000));
await ev(HELPERS);
await sleep(1000);
check("survive: running job picked up on boot", await until(`!!state.jobId
  || !document.getElementById("bg-banner").classList.contains("hidden")
  || document.getElementById("chat").innerText.includes("slow work finished")`, 12000));
check("survive: unpushed job completes after window close", await until(`(async () => {
  const j = (await window.__jobs()).find(x => x.id === ${JSON.stringify(surviveId)});
  return j && j.status === "done";
})()`, 15000));
await sleep(1200);
check("survive: finished answer visible in chat", await ev(`document.getElementById("chat").innerText.includes("slow work finished")`));
await shot("18-survived.png");

// switching chats mid-run must not kill the server job
await ev(`window.__newChat()`);
await sleep(300);
await ev(`window.__pickModel("|slow-6")`);
await ev(`window.__send("keep running when I switch chats")`);
await until(`state.busy && !!state.jobId`, 8000);
const switchJob = await ev(`state.jobId`);
const switchSid = await ev(`state.sessionId`);
await ev(`window.__newChat()`);
await sleep(400);
check("switch: new chat is idle and ready to send", await ev(`!state.busy && !state.jobId && document.getElementById("send-btn").textContent === "↑"`));
check("switch: previous chat's job keeps running on the server", await until(`(async () => {
  const j = (await window.__jobs()).find(x => x.id === ${JSON.stringify(switchJob)});
  return j && (j.status === "running" || j.status === "done");
})()`, 8000), String(switchJob));
check("switch: that job still finishes after leaving the chat", await until(`(async () => {
  const j = (await window.__jobs()).find(x => x.id === ${JSON.stringify(switchJob)});
  return j && j.status === "done";
})()`, 15000));
await ev(`(async () => { await selectSession(${JSON.stringify(switchSid)}); })()`);
await sleep(1200);
check("switch: returning to the chat shows the finished answer", await ev(`document.getElementById("chat").innerText.includes("slow work finished")`));

// stop from the banner
await ev(`window.__newChat()`);
await sleep(300);
await ev(`window.__pickModel("|slow-6")`);
await ev(`window.__send("stop me from the banner")`);
await until(`state.busy && !!state.jobId`, 8000);
await ev(`document.getElementById("push-btn").click()`);
await sleep(300);
const bannerJob = await ev(`document.getElementById("bg-banner").dataset.job || null`);
await ev(`document.getElementById("bg-stop").click()`);
check("stop: banner stop halts the server job", await until(`(async () => {
  const j = (await window.__jobs()).find(x => x.id === ${JSON.stringify(bannerJob)});
  return j && j.status === "stopped";
})()`, 8000), `id=${bannerJob}`);

// ---------- mobile ----------
await metrics(430, 900, true);
await sleep(500);
const m1 = await ev(`JSON.stringify({
  iw: window.innerWidth,
  menu: getComputedStyle(document.getElementById("menu-btn")).display,
  rect: document.querySelector(".sidebar").getBoundingClientRect().right,
  scrim: getComputedStyle(document.getElementById("sidebar-scrim")).pointerEvents
})`);
const m1o = JSON.parse(m1);
check("mobile: hamburger visible, sidebar off-canvas", m1o.iw === 430 && m1o.menu !== "none" && m1o.rect <= 0 && m1o.scrim === "none", m1);
await ev(`document.getElementById("menu-btn").click()`);
await sleep(400);
const m2 = await ev(`JSON.stringify({
  open: document.getElementById("app").classList.contains("nav-open"),
  left: document.querySelector(".sidebar").getBoundingClientRect().left,
  width: document.querySelector(".sidebar").getBoundingClientRect().width,
  scrimOp: getComputedStyle(document.getElementById("sidebar-scrim")).opacity,
  scrimPe: getComputedStyle(document.getElementById("sidebar-scrim")).pointerEvents,
  addVisible: document.querySelector(".projects-label .label-add").getBoundingClientRect().width > 0
})`);
const m2o = JSON.parse(m2);
check("mobile: drawer opens over content with scrim, + reachable",
  m2o.open && m2o.left === 0 && m2o.width > 200 && m2o.scrimOp === "1" && m2o.scrimPe === "auto" && m2o.addVisible, m2);
await shot("19-mobile-drawer.png");
await ev(`document.getElementById("sidebar-scrim").click()`);
await sleep(400);
check("mobile: scrim tap closes drawer", await ev(`!document.getElementById("app").classList.contains("nav-open") && document.querySelector(".sidebar").getBoundingClientRect().right <= 0`));
await ev(`document.getElementById("menu-btn").click()`);
await sleep(350);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(350);
check("mobile: Escape closes drawer", await ev(`!document.getElementById("app").classList.contains("nav-open")`));
await ev(`document.getElementById("menu-btn").click()`);
await sleep(350);
await ev(`document.querySelector(".folder-kids .session-item").click()`);
await sleep(700);
check("mobile: picking a chat closes drawer", await ev(`!document.getElementById("app").classList.contains("nav-open") && !!document.querySelector(".session-item.active")`));

const m3 = await ev(`JSON.stringify({
  doc: document.documentElement.scrollWidth <= window.innerWidth + 1,
  topbar: document.querySelector(".topbar").scrollWidth <= document.querySelector(".topbar").clientWidth + 1,
  composer: document.querySelector(".composer-input-row").scrollWidth <= document.querySelector(".composer-input-row").clientWidth + 1,
  note: document.querySelector(".composer-note").getBoundingClientRect().bottom <= window.innerHeight + 1,
  sendVisible: document.getElementById("send-btn").getBoundingClientRect().right <= window.innerWidth,
  hints: document.getElementById("slash-hint").getBoundingClientRect().right <= window.innerWidth
})`);
const m3o = JSON.parse(m3);
check("mobile: topbar/composer fit, send + hints reachable", m3o.doc && m3o.topbar && m3o.composer && m3o.note && m3o.sendVisible && m3o.hints, m3);
await shot("20-mobile.png");

await ev(`window.__type("/code")`);
await sleep(350);
const m4 = await ev(`JSON.stringify({
  open: window.__paletteOpen(),
  r: document.getElementById("cmd-palette").getBoundingClientRect(),
  iw: window.innerWidth, ih: window.innerHeight
})`);
const m4o = JSON.parse(m4);
check("mobile: palette fits the viewport above the composer",
  m4o.open && m4o.r.left >= -1 && m4o.r.right <= m4o.iw + 1 && m4o.r.top >= -1 && m4o.r.bottom <= m4o.ih + 1, m4);
await shot("21-mobile-palette.png");
await ev(`document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);

await ev(`window.__rowMenu()`);
await sleep(300);
const m5 = await ev(`JSON.stringify({ open: window.__menuOpen(), r: document.getElementById("ctx-menu").getBoundingClientRect(), iw: window.innerWidth, ih: window.innerHeight })`);
const m5o = JSON.parse(m5);
check("mobile: chat menu stays on screen", m5o.open && m5o.r.left >= -1 && m5o.r.right <= m5o.iw + 1 && m5o.r.top >= -1 && m5o.r.bottom <= m5o.ih + 1, m5);
await ev(`window.__menuItem("Delete chat")`);
await sleep(350);
const m6 = await ev(`JSON.stringify({ open: window.__modalOpen(), r: document.getElementById("modal-card").getBoundingClientRect(), iw: window.innerWidth, ih: window.innerHeight })`);
const m6o = JSON.parse(m6);
check("mobile: confirmation modal fits and both buttons reachable", await ev(`(() => {
  const ok = document.getElementById("modal-ok").getBoundingClientRect();
  const c = document.getElementById("modal-cancel").getBoundingClientRect();
  return ok.right <= window.innerWidth + 1 && ok.bottom <= window.innerHeight + 1 && c.left >= -1 && ok.width > 60;
})()`) && m6o.open && m6o.r.left >= -1 && m6o.r.right <= m6o.iw + 1, m6);
await shot("22-mobile-confirm.png");
await ev(`document.getElementById("modal-cancel").click()`);
await sleep(250);

await ev(`document.getElementById("settings-btn").click()`);
await ev(`document.querySelector('.set-item[data-tab="chat"]').click()`);
await sleep(400);
const m7 = await ev(`JSON.stringify({
  doc: document.documentElement.scrollWidth <= window.innerWidth + 1,
  rows: [...document.querySelectorAll("#tab-chat .switch-row")].every(r => r.scrollWidth <= r.clientWidth + 1),
  sw: [...document.querySelectorAll("#tab-chat .switch-pill")].every(s => s.getBoundingClientRect().right <= window.innerWidth + 1)
})`);
const m7o = JSON.parse(m7);
check("mobile: settings chat tab has no overflow, switches reachable", m7o.doc && m7o.rows && m7o.sw, m7);
await shot("23-mobile-settings.png");
await ev(`document.getElementById("settings-close").click()`);
await sleep(300);

// ---------- final state ----------
await metrics(1440, 900, false);
await sleep(400);
const fin = await ev(`JSON.stringify({
  doc: document.documentElement.scrollWidth <= window.innerWidth + 1,
  errors: 0,
  prefs: null
})`);
check("final: desktop layout still clean", JSON.parse(fin).doc, fin);
check("runtime: no uncaught JS errors during the whole suite", consoleErrors.length === 0, consoleErrors.slice(0, 4).join(" | "));
await shot("24-desktop-final.png");

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
console.log(failed ? "UI CHECKS FAILED" : "ALL UI CHECKS PASSED");
ws.close();
process.exit(process.exitCode || 0);