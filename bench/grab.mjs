#!/usr/bin/env node
// bench/grab.js — CDP 证据抓取(双侧统一入口)
//
// 为什么不用 REA 的 capture_web_screenshot:它按 http/https 源做策略,
// 我们的目标是 file:// → 实测 target_not_allowed。这里直连各 target 自己的
// webSocketDebuggerUrl(Node 22 起内置 WebSocket),不依赖任何外部包。
//
// 为什么不用 AppleScript 摆位:本机"辅助功能"未授权(-25211)。
// 但 CDP 仍能**读**窗口几何(screenX/screenY/outerWidth/outerHeight)→ 见 --geom。
//
// 用法:
//   node bench/grab.js --port 9222                       # 自动挑 primary 页
//   node bench/grab.js --port 9222 --url-match primary --out bench/sessions/x.png
//   node bench/grab.js --port 9223 --geom                # 只读几何(JSON)
//   node bench/grab.js --port 9222 --dom                 # 另存 DOM 快照
//
// 输出:PNG + 一行 JSON 摘要(几何/标题/大小),便于写进 FINDINGS.md

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const port = opt("--port", "9222");
const urlMatch = opt("--url-match", null);
const out = opt("--out", null);
const domOut = opt("--dom", null);
const geomOnly = args.includes("--geom");

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = list.filter((t) => t.type === "page");
if (!pages.length) { console.error(`port ${port}: 无 page target`); process.exit(2); }
const t = urlMatch
  ? pages.find((p) => (p.url || "").includes(urlMatch) || (p.title || "").includes(urlMatch))
  : pages[0];
if (!t) { console.error(`port ${port}: 没有匹配 "${urlMatch}" 的 target`); process.exit(2); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => pending.has(i) && (pending.delete(i), rej(new Error(`${method} timeout`))), 15000);
});
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
});
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("ws connect failed"))); });

const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;

const geom = JSON.parse(await ev(
  'JSON.stringify({sx:screenX,sy:screenY,ow:outerWidth,oh:outerHeight,iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio})'
) || "null");
const title = await ev("document.title");
const summary = { port, targetId: t.id, url: t.url, title, geom };

if (geomOnly) {
  console.log(JSON.stringify(summary, null, 1));
  ws.close(); process.exit(0);
}

if (out) {
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  summary.png = out;
  summary.bytes = Buffer.from(shot.data, "base64").length;
}
if (domOut) {
  const html = await ev("document.documentElement.outerHTML");
  writeFileSync(domOut, String(html ?? ""));
  summary.dom = domOut;
}
console.log(JSON.stringify(summary));
ws.close(); process.exit(0);
