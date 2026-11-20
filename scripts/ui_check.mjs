// Responsive / sidebar / background-job UI checks over Chrome DevTools Protocol.
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
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
    await sleep(200);
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

// ---------- desktop ----------
await metrics(1440, 900, false);
await send("Page.navigate", { url: APP });
await until(`!document.getElementById("app").classList.contains("hidden") || !document.getElementById("login-screen").classList.contains("hidden")`);
if (await ev(`!document.getElementById("login-screen").classList.contains("hidden")`)) {
  await ev(`(() => { document.getElementById("login-password").value = "test-pass"; document.getElementById("login-btn").click(); })()`);
}
check("desktop: login enters app", await until(`!document.getElementById("app").classList.contains("hidden")`));
await sleep(600);

const d1 = await ev(`JSON.stringify({
  menu: getComputedStyle(document.getElementById("menu-btn")).display,
  pos: getComputedStyle(document.querySelector(".sidebar")).position,
  folders: document.querySelectorAll(".proj-folder").length,
  kids: document.querySelectorAll(".folder-kids .session-item").length,
  active: document.querySelectorAll(".session-item.active").length
})`);
const d1o = JSON.parse(d1);
check("desktop: hamburger hidden, sidebar inline", d1o.menu === "none" && d1o.pos === "static", d1);
check("desktop: project folders with chats + active row", d1o.folders >= 1 && d1o.kids >= 1 && d1o.active === 1, d1);

const d2 = await ev(`(async () => {
  const find = (name) => [...document.querySelectorAll(".proj-folder")].find(f => f.querySelector(".folder-name").textContent === name);
  const head = document.querySelector(".proj-folder .folder-head");
  const name = head.querySelector(".folder-name").textContent;
  const had = !!find(name).querySelector(".folder-kids");
  head.click();
  const collapsedNow = !find(name).querySelector(".folder-kids");
  const stored = JSON.parse(localStorage.getItem("collapsedProjects") || "[]").length > 0;
  find(name).querySelector(".folder-head").click();
  const reopened = !!find(name).querySelector(".folder-kids");
  return JSON.stringify({ had, collapsedNow, stored, reopened });
})()`);
const d2o = JSON.parse(d2);
check("desktop: folder collapse/expand + persistence", d2o.had && d2o.collapsedNow && d2o.stored && d2o.reopened, d2);

const d3 = await ev(`(async () => {
  const row = document.querySelector(".folder-kids .session-item");
  const id = [...document.querySelectorAll(".session-item")].indexOf(row);
  row.click();
  await new Promise(r => setTimeout(r, 700));
  const active = document.querySelector(".session-item.active");
  return JSON.stringify({
    activeInFolder: !!active && !!active.closest(".folder-kids"),
    chatLoaded: !document.getElementById("chat").classList.contains("hidden")
  });
})()`);
const d3o = JSON.parse(d3);
check("desktop: chat inside folder selectable + highlighted", d3o.activeInFolder, d3);

const d4 = await ev(`JSON.stringify({
  doc: document.documentElement.scrollWidth <= window.innerWidth + 1,
  topbar: document.querySelector(".topbar").scrollWidth <= document.querySelector(".topbar").clientWidth + 1,
  composer: document.querySelector(".composer-input-row").scrollWidth <= document.querySelector(".composer-input-row").clientWidth + 1
})`);
const d4o = JSON.parse(d4);
check("desktop: no horizontal overflow", d4o.doc && d4o.topbar && d4o.composer, d4);
await shot("desktop.png");

// ---------- mobile ----------
await metrics(430, 900, true);
await sleep(400);
const m1 = await ev(`JSON.stringify({
  iw: window.innerWidth,
  menu: getComputedStyle(document.getElementById("menu-btn")).display,
  rect: document.querySelector(".sidebar").getBoundingClientRect().right,
  scrim: getComputedStyle(document.getElementById("sidebar-scrim")).pointerEvents
})`);
const m1o = JSON.parse(m1);
check("mobile: hamburger visible, sidebar off-canvas", m1o.iw === 430 && m1o.menu !== "none" && m1o.rect <= 0 && m1o.scrim === "none", m1);

await ev(`document.getElementById("menu-btn").click()`);
await sleep(350);
const m2 = await ev(`JSON.stringify({
  open: document.getElementById("app").classList.contains("nav-open"),
  left: document.querySelector(".sidebar").getBoundingClientRect().left,
  width: document.querySelector(".sidebar").getBoundingClientRect().width,
  scrimOp: getComputedStyle(document.getElementById("sidebar-scrim")).opacity,
  scrimPe: getComputedStyle(document.getElementById("sidebar-scrim")).pointerEvents
})`);
const m2o = JSON.parse(m2);
check("mobile: drawer opens over content with scrim", m2o.open && m2o.left === 0 && m2o.width > 200 && m2o.scrimOp === "1" && m2o.scrimPe === "auto", m2);
await shot("mobile-drawer.png");

await ev(`document.getElementById("sidebar-scrim").click()`);
await sleep(350);
check("mobile: scrim tap closes drawer", await ev(`!document.getElementById("app").classList.contains("nav-open") && document.querySelector(".sidebar").getBoundingClientRect().right <= 0`));

await ev(`document.getElementById("menu-btn").click()`);
await sleep(300);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);
check("mobile: Escape closes drawer", await ev(`!document.getElementById("app").classList.contains("nav-open")`));

const m3 = await ev(`JSON.stringify({
  doc: document.documentElement.scrollWidth <= window.innerWidth + 1,
  topbar: document.querySelector(".topbar").scrollWidth <= document.querySelector(".topbar").clientWidth + 1,
  composer: document.querySelector(".composer-input-row").scrollWidth <= document.querySelector(".composer-input-row").clientWidth + 1,
  note: document.querySelector(".composer-note").getBoundingClientRect().bottom <= window.innerHeight + 1,
  sendVisible: document.getElementById("send-btn").getBoundingClientRect().right <= window.innerWidth
})`);
const m3o = JSON.parse(m3);
check("mobile: topbar/composer fit, send reachable", m3o.doc && m3o.topbar && m3o.composer && m3o.note && m3o.sendVisible, m3);

await ev(`document.getElementById("menu-btn").click()`);
await sleep(300);
await ev(`document.querySelector(".folder-kids .session-item").click()`);
await sleep(600);
check("mobile: picking a chat closes drawer", await ev(`!document.getElementById("app").classList.contains("nav-open") && !!document.querySelector(".session-item.active")`));
await shot("mobile.png");

// ---------- push + background survival ----------
await metrics(1440, 900, false);
await sleep(300);
const prov = await ev(`(async () => {
  let ps = await json(await api("/api/providers"));
  let p = ps.find(x => (x.base_url || "").endsWith("9504/v1"));
  if (!p) p = await json(await api("/api/providers", { method: "POST", body: { name: "Slow6", base_url: "http://127.0.0.1:9504/v1", api_key: "x", models: ["slow-6"] } }));
  await loadProviders();
  const sel = document.getElementById("model-select");
  sel.value = p.id + "|slow-6";
  sel.dispatchEvent(new Event("change"));
  return sel.value;
})()`);
check("push: slow provider selected", String(prov).includes("|slow-6"), String(prov));

await ev(`(async () => {
  const prev = state.sessionId;
  document.getElementById("new-chat-btn").click();
  for (let i = 0; i < 80 && state.sessionId === prev; i++) await new Promise(r => setTimeout(r, 50));
  const sel = document.getElementById("model-select");
  sel.value = ${JSON.stringify(prov)};
  sel.dispatchEvent(new Event("change"));
  document.getElementById("input").value = "background push test";
  document.getElementById("send-btn").click();
})()`);
await until(`state.busy && !!state.jobId`, 6000);
const p1 = await ev(`JSON.stringify({ busy: state.busy, job: !!state.jobId, pushVisible: !document.getElementById("push-btn").classList.contains("hidden") })`);
const p1o = JSON.parse(p1);
check("push: button appears while running", p1o.busy && p1o.job && p1o.pushVisible, p1);

await ev(`document.getElementById("push-btn").click()`);
await sleep(120);
const p2 = await ev(`JSON.stringify({
  banner: !document.getElementById("bg-banner").classList.contains("hidden"),
  detached: state.detached,
  busy: state.busy
})`);
const p2o = JSON.parse(p2);
check("push: banner shows immediately after push", p2o.banner && p2o.detached && !p2o.busy, p2);
await shot("push-banner.png");

check("push: job finishes server-side after push", await until(`(async () => {
  const js = await json(await api("/api/jobs"));
  const j = js.find(x => x.id === document.getElementById("bg-banner").dataset.job);
  return j && j.status === "done";
})()`, 12000));
await ev(`document.getElementById("bg-resume").click()`);
await sleep(800);
check("push: resume replays finished output", await ev(`document.getElementById("chat").innerText.includes("slow work finished")`));

// close window mid-run WITHOUT push
await ev(`(async () => {
  const prev = state.sessionId;
  document.getElementById("new-chat-btn").click();
  for (let i = 0; i < 80 && state.sessionId === prev; i++) await new Promise(r => setTimeout(r, 50));
  const sel = document.getElementById("model-select");
  sel.value = ${JSON.stringify(prov)};
  sel.dispatchEvent(new Event("change"));
  document.getElementById("input").value = "survive window close";
  document.getElementById("send-btn").click();
})()`);
await until(`state.busy && !!state.jobId`, 6000);
const jobId = await ev(`state.jobId`);
check("survive: job running before reload", !!jobId, String(jobId));
await send("Page.reload");
check("survive: app boots after reload", await until(`!document.getElementById("app").classList.contains("hidden")`, 10000));
await sleep(800);
const s1 = await ev(`JSON.stringify({ picked: state.sessionId, resumed: !!state.jobId || !document.getElementById("bg-banner").classList.contains("hidden") })`);
const s1o = JSON.parse(s1);
check("survive: running job picked up on boot", s1o.resumed, s1);
check("survive: unpushed job completes after window close", await until(`(async () => {
  const js = await json(await api("/api/jobs"));
  const j = js.find(x => x.id === ${JSON.stringify(jobId)});
  return j && j.status === "done";
})()`, 12000));
await sleep(600);
check("survive: finished answer visible in chat", await ev(`document.getElementById("chat").innerText.includes("slow work finished")`));

// stop from banner
await ev(`(async () => {
  const prev = state.sessionId;
  document.getElementById("new-chat-btn").click();
  for (let i = 0; i < 80 && state.sessionId === prev; i++) await new Promise(r => setTimeout(r, 50));
  const sel = document.getElementById("model-select");
  sel.value = ${JSON.stringify(prov)};
  sel.dispatchEvent(new Event("change"));
  document.getElementById("input").value = "stop me";
  document.getElementById("send-btn").click();
})()`);
await until(`state.busy && !!state.jobId`, 6000);
await ev(`document.getElementById("push-btn").click()`);
await sleep(200);
const stopId = await ev(`document.getElementById("bg-banner").dataset.job || null`);
const stopDbg = await ev(`JSON.stringify({ banner: !document.getElementById("bg-banner").classList.contains("hidden"), busy: state.busy, jobId: state.jobId })`);
await ev(`document.getElementById("bg-stop").click()`);
const stopOk = await until(`(async () => {
  const js = await json(await api("/api/jobs"));
  const j = js.find(x => x.id === ${JSON.stringify(stopId)});
  return j && j.status === "stopped";
})()`, 8000);
const stopAfter = await ev(`(async () => {
  const js = await json(await api("/api/jobs"));
  const j = js.find(x => x.id === ${JSON.stringify(stopId)});
  return j ? j.status : "missing";
})()`);
check("stop: banner stop halts job", stopOk, `id=${stopId} pre=${stopDbg} post=${stopAfter}`);
await shot("desktop-final.png");

console.log(results.join("\n"));
console.log(results.every((r) => r.startsWith("PASS")) ? "\nALL UI CHECKS PASSED" : "\nUI CHECKS FAILED");
ws.close();
process.exit(process.exitCode || 0);