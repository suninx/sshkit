// 查某个元素上实际挂了哪些事件监听(CDP DOMDebugger.getEventListeners)
// 用法: node bench/listeners.mjs [port] [selector...]
const port = process.argv[2] || "9223";
const sels = process.argv.slice(3);
if (!sels.length) sels.push("#btn-appearance");
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
for (const sel of sels) {
  const r = await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(sel)})` });
  const oid = r.result?.result?.objectId;
  if (!oid) { console.log(`${sel.padEnd(22)} 元素不存在`); continue; }
  const l = await send("DOMDebugger.getEventListeners", { objectId: oid, depth: 0, pierce: false });
  const ls = (l.result?.listeners ?? []).map((x) => `${x.type}${x.useCapture ? "(capture)" : ""}`);
  console.log(`${sel.padEnd(22)} ${ls.length ? ls.join(", ") : "（无监听）"}`);
}
process.exit(0);
