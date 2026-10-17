// bench/probes/newtab-menu.js — 点开"+"并当场解剖弹层(T2,会改动界面状态)
//
// 用法:node bench/grab.mjs --port 9222 --url-match primary --eval-file bench/probes/newtab-menu.js
// 为什么必须一次求值完成:弹层在窗口失焦/后续操作时会关闭,分两步探测会拿到空结果(踩过)。
// 说明:该弹层没有 role=menu 等 ARIA 角色,只能靠文本与几何定位。

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const box = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const st = (e, props) => { const s = getComputedStyle(e); const o = {}; for (const p of props) o[p] = s[p]; return o; };

  const btn = document.querySelector('[data-testid="new-tab-button"]');
  if (!btn) return { err: "找不到 new-tab-button" };
  const before = document.body.innerText.length;
  btn.click();
  await sleep(900);

  const leafByText = (t) => [...document.querySelectorAll("*")].find((e) => (e.textContent || "").trim() === t);
  const anchor = leafByText("New Tab") || leafByText("Recent sessions");
  if (!anchor) {
    return { opened: false, note: "点击后未见 New Tab / Recent sessions 文本", bodyLenBefore: before, bodyLenAfter: document.body.innerText.length };
  }

  // 从条目往上爬到弹层容器:父元素明显更大时即为容器
  let container = anchor;
  for (let i = 0; i < 6; i++) {
    const p = container.parentElement;
    if (!p) break;
    const pr = p.getBoundingClientRect();
    if (pr.width > 520 || pr.height > 420) break;
    container = p;
  }

  const cr = container.getBoundingClientRect();
  const items = [...container.querySelectorAll("*")]
    .filter((e) => {
      const r = e.getBoundingClientRect();
      const txt = (e.textContent || "").replace(/\s+/g, " ").trim();
      return r.height >= 16 && r.height <= 64 && r.width >= 100 && txt.length >= 2 && e.children.length <= 4;
    })
    .slice(0, 16)
    .map((e) => ({
      tag: e.tagName,
      box: box(e),
      text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
      hasIcon: !!e.querySelector("svg,img"),
      style: st(e, ["backgroundColor", "color", "fontSize", "fontWeight", "borderRadius", "paddingLeft", "borderBottom"]),
    }));

  return {
    opened: true,
    bodyLenBefore: before,
    bodyLenAfter: document.body.innerText.length,
    container: { box: box(container), style: st(container, ["backgroundColor", "borderRadius", "boxShadow", "padding", "border", "width"]) },
    items,
    containerText: (container.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
  };
})()
