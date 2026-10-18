#!/usr/bin/env node
// bench/grab.mjs — CDP 证据抓取(双侧统一入口)
//
// 为什么不用 REA 的 capture_web_screenshot:它按 http/https 源做策略,
// 我们的目标是 file:// → 实测 target_not_allowed。这里直连各 target 自己的
// webSocketDebuggerUrl(Node 22 起内置 WebSocket),不依赖任何外部包。
//
// 为什么不用 AppleScript 摆位:本机"辅助功能"未授权(-25211)。
// 但 CDP 仍能**读**窗口几何(screenX/screenY/outerWidth/outerHeight)→ 见 --geom。
//
// 用法:
//   node bench/grab.mjs --port 9222                       # 自动挑 primary 页
//   node bench/grab.mjs --port 9222 --url-match primary --out x.png --dom x.html
//   node bench/grab.mjs --port 9223 --geom                # 只读几何(JSON)
//   node bench/grab.mjs --port 9222 --eval 'document.title'          # 任意取值
//   node bench/grab.mjs --port 9222 --eval-file probe.js             # 取值(避免引号地狱)
//
// 输出:PNG + 一行 JSON 摘要(几何/标题/大小),便于写进 FINDINGS.md
// 注意:--eval/--eval-file 会**求值**页面 JS(只读取;不要用它改动对方状态)。

import { writeFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const port = opt("--port", "9222");
const urlMatch = opt("--url-match", null);
const out = opt("--out", null);
const domOut = opt("--dom", null);
const geomOnly = args.includes("--geom");
const evalFile = opt("--eval-file", null);
const evalExpr = evalFile ? readFileSync(evalFile, "utf8") : opt("--eval", null);

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

if (evalExpr) {
  const r = await send("Runtime.evaluate", { expression: evalExpr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) { console.error(`eval 抛错: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`); ws.close(); process.exit(5); }
  console.log(JSON.stringify(r.result?.value ?? null, null, 1));
  ws.close(); process.exit(0);
}

if (out) {
  /* 窗口在后台时合成器会被节流,captureScreenshot 可能返回上一帧(实测:截图比状态慢一帧)。
     先把目标页提到前台,并连抓两次取第二张。 */
  try { await send("Page.bringToFront", {}); } catch { /* 老版本可能不支持 */ }
  await new Promise((r) => setTimeout(r, 150));
  await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await new Promise((r) => setTimeout(r, 120));
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
