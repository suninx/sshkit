#!/usr/bin/env node
// bench/drive.mjs — CDP 驱动(会**改动**对面界面状态;与只读的 grab.mjs 严格分开)
//
// 用途:点开原版的面板/菜单取规格(T2 Tab、T3 端口转发、T6 Known Hosts…)。
// 纪律:每一步都存 before/after 截图+DOM 并打印动作摘要,便于写进 FINDINGS。
//       只点"导航/展开"类控件;不点删除、不提交表单、不建连接。
//
// 用法:
//   node bench/drive.mjs --port 9222 --testid new-tab-button --tag t2-newtab
//   node bench/drive.mjs --port 9222 --text "Port Forwarding" --tag t3-panel
//   node bench/drive.mjs --port 9222 --selector 'button[aria-label="Change layout"]' --tag x
//   node bench/drive.mjs --port 9223 --type 'printf "hi"' --enter --tag t1-echo   # 往终端打字
//
// 可选:--url-match primary  --wait 600(点后等多久再看)  --out-dir <目录>  --dry(只解析不点)
//       --type 时用 --focus 指定先点哪个元素把焦点给终端(默认 .xterm-screen)

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const port = opt("--port", "9222");
const urlMatch = opt("--url-match", null);
const testid = opt("--testid", null);
const selector = opt("--selector", null);
const text = opt("--text", null);
const typeText_ = opt("--type", null);
const typeFile = opt("--type-file", null);
const insertFile = opt("--insert-file", null);
const insertStr = insertFile ? readFileSync(insertFile, "utf8").replace(/\n+$/, "") : opt("--insert", null);
const typeStr = insertStr ?? (typeFile ? readFileSync(typeFile, "utf8").replace(/\n+$/, "") : typeText_);
const useInsert = !!insertStr;
const doEnter = args.includes("--enter");
const focusSel = opt("--focus", ".xterm-screen");
const tag = opt("--tag", "drive");
const waitMs = Number(opt("--wait", "700"));
const dry = args.includes("--dry");
const probeFile = opt("--probe-file", null); // 点击后立刻在同一次会话里求值(弹层类 UI 必须如此:
                                             // 中间任何停顿/失焦都会让弹层关闭,分两步探测只能拿到空结果)
const clearFirst = args.includes("--clear"); // 写入前先全选:insertText 是插入,带默认值的输入框会变追加
const keyCombo = opt("--key", null);         // 例:"cmd+w" / "cmd+shift+]" —— 发组合键(测快捷键用)
const outDir = opt("--out-dir", `bench/sessions/${new Date().toLocaleString("sv-SE").replace(/[: ]/g, "_")}-${tag}`);

if (!testid && !selector && !text && !typeStr && !keyCombo) { console.error("需要 --testid / --selector / --text / --type / --key 之一"); process.exit(2); }

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = list.filter((t) => t.type === "page");
const t = urlMatch ? pages.find((p) => (p.url || "").includes(urlMatch) || (p.title || "").includes(urlMatch)) : pages[0];
if (!t) { console.error(`port ${port}: 没有匹配的 page target`); process.exit(2); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => pending.has(i) && (pending.delete(i), rej(new Error(`${method} timeout`))), 15000);
});
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result); }
});
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("ws connect failed"))); });

const ev = async (expr, extra = {}) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, ...extra });
  if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 便宜但够用的"变了没"指纹:节点数 + 可见按钮文本
// 界面"变化"指纹。教训:早期只统计节点数 + 按钮文本,对**列表重排/排序结果**不敏感,
// 于是把"排序生效了"误判成"无变化",还会触发下面的合成点击回退 → 一次点击被处理两次。
// 现在把可见文本本身也算进来(顺序敏感)。
const fingerprint = () => ev(`(() => {
  const n = document.querySelectorAll('*').length;
  const b = [...document.querySelectorAll('button')].map(e => (e.textContent||'').replace(/\\s+/g,' ').trim()).join('|');
  const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
  let h = 0;                                   // 简易 32 位散列,顺序敏感
  for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) | 0; }
  // 选中态/开关态也算进指纹:否则"多选后背景变了、文本没变"会被误判成无变化,触发合成回退点击,
  // 而那个回退点击没有修饰键,会把多选重置成单选(实测踩到,白查了一轮)
  const sel = [...document.querySelectorAll('.sel,.on,[aria-selected=true]')]
    .map(e => (e.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 24)).join('|');
  return n + '::' + b.length + '::' + b.slice(0, 200) + '::' + t.length + '::' + h + '::' + sel;
})()`);

mkdirSync(outDir, { recursive: true });
const base = `${outDir}/${tag}`;

async function shoot(p) {
  const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(p, Buffer.from(s.data, "base64"));
  return Buffer.from(s.data, "base64").length;
}
async function dump(p) { writeFileSync(p, String(await ev("document.documentElement.outerHTML") ?? "")); }

// ---- 解析目标 ----
let desc;
if (testid) {
  desc = { by: "testid", value: testid, sel: `[data-testid="${testid}"]` };
} else if (selector) {
  desc = { by: "selector", value: selector, sel: selector };
} else {
  desc = { by: "text", value: text, sel: null };
}

const found = await ev(`(() => {
  const sel = ${JSON.stringify(desc.sel)};
  let el = sel ? document.querySelector(sel) : null;
  if (!el && ${JSON.stringify(text)} !== null) {
    const want = ${JSON.stringify(text)}.toLowerCase();
    const txt = (e) => (e.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const cands = [...document.querySelectorAll('button,[role=button],a,li,div,span')].filter((e) => txt(e).includes(want));
    // 选"最小的那个" —— 避免点到把整页包住的大容器
    cands.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    });
    el = cands.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || null;
  }
  if (!el) return null;
  el.scrollIntoView({block:'center'});
  const r = el.getBoundingClientRect();
  return { tag: el.tagName, text: (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60),
           testid: el.dataset.testid||null, aria: el.getAttribute('aria-label'),
           x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
           w: Math.round(r.width), h: Math.round(r.height), visible: r.width>0 && r.height>0 };
})()`);

if (!typeStr && !keyCombo && !found) { console.error(`找不到目标:${JSON.stringify(desc)}`); ws.close(); process.exit(3); }
if (found) console.log(`目标: <${found.tag}> "${found.text}"${found.testid ? ` testid=${found.testid}` : ""}${found.aria ? ` aria=${found.aria}` : ""} @(${found.x},${found.y}) ${found.w}x${found.h} visible=${found.visible}`);

if (dry && !typeStr && !keyCombo) { console.log("--dry:不点击"); ws.close(); process.exit(0); }
if (!typeStr && !keyCombo && !found.visible) { console.error("目标不可见(0 尺寸)→ 不点,避免盲点"); ws.close(); process.exit(4); }


// ---- 组合键动作(--key)----
function parseCombo(combo) {
  const parts = combo.toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  const mods = { cmd: 4, meta: 4, ctrl: 2, control: 2, alt: 1, option: 1, shift: 8 };
  let modifiers = 0; const keys = [];
  for (const p of parts) (mods[p] !== undefined ? (modifiers |= mods[p]) : keys.push(p));
  const k = keys[keys.length - 1] || "";
  const named = { enter: ["Enter", "Enter", 13], tab: ["Tab", "Tab", 9], esc: ["Escape", "Escape", 27],
    escape: ["Escape", "Escape", 27], space: [" ", "Space", 32], backspace: ["Backspace", "Backspace", 8] };
  let key = k, code, vk;
  if (named[k]) { [key, code, vk] = named[k]; }
  else if (/^[a-z]$/.test(k)) { key = k; code = "Key" + k.toUpperCase(); vk = k.toUpperCase().charCodeAt(0); }
  else if (/^[0-9]$/.test(k)) { key = k; code = "Digit" + k; vk = k.charCodeAt(0); }
  else { key = k; code = k; vk = k.length === 1 ? k.charCodeAt(0) : 0; }
  return { key, code, vk, modifiers };
}

if (keyCombo) {
  const c = parseCombo(keyCombo);
  console.log(`组合键: ${keyCombo} → key=${c.key} code=${c.code} vk=${c.vk} modifiers=${c.modifiers}`);
  if (dry) { console.log("--dry:不发键"); ws.close(); process.exit(0); }
  await shoot(`${base}-before.png`);
  const common = { key: c.key, code: c.code, windowsVirtualKeyCode: c.vk, nativeVirtualKeyCode: c.vk, modifiers: c.modifiers };
  await send("Input.dispatchKeyEvent", { type: "keyDown", text: c.modifiers === 0 && c.key.length === 1 ? c.key : undefined, ...common });
  await sleep(60);
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  await sleep(Math.max(waitMs, 600));
  await shoot(`${base}-after.png`); await dump(`${base}-after.html`);
  const fp = await fingerprint();
  let probeResult2;
  if (probeFile) {
    const r2 = await send("Runtime.evaluate", { expression: readFileSync(probeFile, "utf8"), returnByValue: true, awaitPromise: true });
    probeResult2 = r2.exceptionDetails ? { probeError: r2.exceptionDetails.text } : r2.result?.value;
  }
  console.log(JSON.stringify({ port, targetId: t.id, action: "key", combo: keyCombo, parsed: c,
    artifacts: { beforePng: `${base}-before.png`, afterPng: `${base}-after.png` }, ...(probeFile ? { probe: probeResult2 } : {}) }, null, 1));
  console.log("✅ 已发送组合键");
  ws.close(); process.exit(0);
}

// ---- 打字动作(--type)----
const clickMods = (() => {           // --mods cmd|shift|cmd+shift —— 带修饰键的真实鼠标点击(测多选/范围选)
  const v = opt("--mods", "");
  let m = 0;
  if (/cmd|meta/.test(v)) m |= 4;
  if (/shift/.test(v)) m |= 8;
  if (/alt|option/.test(v)) m |= 1;
  if (/ctrl|control/.test(v)) m |= 2;
  return m;
})();

async function clickPoint(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers: clickMods });
  await sleep(120);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: clickMods });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: clickMods });
}

async function typeChar(ch) {
  // ⚠️ 实测教训:不能把字符码直接当 windowsVirtualKeyCode。
  // 'p'=112/'r'=114/'t'=116 恰好落在 VK_F1..F12(112..123)区间,xterm 会当功能键吃掉,
  // 于是 "clear"→"clea"、"printf"→"in-f"。字母一律用大写码(即标准 VK 映射)。
  const isLetter = /[a-zA-Z]/.test(ch);
  const vk = isLetter ? ch.toUpperCase().charCodeAt(0) : ch.charCodeAt(0);
  const code = isLetter ? `Key${ch.toUpperCase()}` : /[0-9]/.test(ch) ? `Digit${ch}` : ch;
  const common = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, ...common });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  await sleep(12);
}

if (typeStr) {
  const focusBox = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(focusSel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  if (!focusBox) { console.error(`找不到焦点元素 ${focusSel}`); ws.close(); process.exit(3); }
  console.log(`焦点: ${focusSel} @(${focusBox.x},${focusBox.y}) ${focusBox.w}x${focusBox.h}`);
  if (dry) { console.log("--dry:不打字"); ws.close(); process.exit(0); }

  await shoot(`${base}-before.png`); await dump(`${base}-before.html`);
  await clickPoint(focusBox.x, focusBox.y);       // 点终端,把焦点交给 xterm 的 textarea
  await sleep(250);
  const focused = await ev(`document.activeElement ? document.activeElement.className : null`);
  console.log(`activeElement: ${focused}`);
  if (clearFirst) {
    // 先全选:Input.insertText 是"插入",带默认值的输入框会变成追加(实测把 0.0.0.0 写成了 0.0.0.0127.0.0.1)
    // 注意:CDP 的按键事件不会自动执行编辑命令,必须显式给 commands(否则"全选"不发生,写入变追加 —— 踩过)
    const metaA = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...metaA, commands: ["selectAll"] });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...metaA });
    await sleep(80);
  }
  if (useInsert) {
    // 整串插入:不经键位映射,故反斜杠等字符不会被吞(逐键模式实测会丢 '\')
    await send("Input.insertText", { text: typeStr });
  } else {
    for (const ch of [...typeStr]) await typeChar(ch);
  }
  if (doEnter) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
  await sleep(Math.max(waitMs, 1200));
  const afterBytes = await shoot(`${base}-after.png`); await dump(`${base}-after.html`);
  console.log(JSON.stringify({
    port, targetId: t.id, action: "type", typed: typeStr, enter: doEnter, activeElement: focused,
    artifacts: { beforePng: `${base}-before.png`, afterPng: `${base}-after.png`, afterHtml: `${base}-after.html` }, afterBytes,
  }, null, 1));
  console.log("✅ 已输入并抓图");
  ws.close(); process.exit(0);
}

const beforeFp = await fingerprint();
const beforeBytes = await shoot(`${base}-before.png`);
await dump(`${base}-before.html`);

// ---- 真实鼠标事件(比 el.click() 更接近人:带 move/hover) ----
await clickPoint(found.x, found.y);
await sleep(waitMs);

const afterFp = await fingerprint();
let afterBytes = await shoot(`${base}-after.png`);
await dump(`${base}-after.html`);

let changed = beforeFp !== afterFp;
if (!changed && !probeFile) {
  // 有些控件只认合成 click(React 委托),补一次
  await ev(`(() => { const sel=${JSON.stringify(desc.sel)}; let el = sel ? document.querySelector(sel) : null;
    if(!el && ${JSON.stringify(text)} !== null){const w=${JSON.stringify(text)}.toLowerCase();
      el=[...document.querySelectorAll('button,[role=button],a')].find(e=>((e.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase()).includes(w));}
    if(el) el.click(); return !!el; })()`);
  await sleep(waitMs);
  const fp3 = await fingerprint();
  if (fp3 !== beforeFp) { changed = true; afterBytes = await shoot(`${base}-after.png`); await dump(`${base}-after.html`); }
}

// ---- 点击后当场探测(--probe-file)----
// 弹层/菜单/悬浮面板必须这样测:同一次会话、紧接着点完就求值。
let probeResult;
if (probeFile) {
  const src = readFileSync(probeFile, "utf8");
  const r = await send("Runtime.evaluate", { expression: src, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) probeResult = { probeError: r.exceptionDetails.text };
  else probeResult = r.result?.value;
}

const summary = {
  port, targetId: t.id, action: "click", target: { ...desc, resolved: found },
  changed, waitMs,
  artifacts: { beforePng: `${base}-before.png`, afterPng: `${base}-after.png`, beforeHtml: `${base}-before.html`, afterHtml: `${base}-after.html` },
  beforeBytes, afterBytes,
  ...(probeFile ? { probe: probeResult } : {}),
};
console.log(JSON.stringify(summary, null, 1));
console.log(changed ? "✅ 界面有变化(after.* 即新状态)" : "⚠️ 界面无变化 —— 可能不是点击触发(或需 hover/二次点击)");
ws.close(); process.exit(0);
