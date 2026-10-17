// bench/probes/popup-anatomy.js — 通用弹层解剖(配合 drive.mjs --probe-file 使用)
//
// 用法:node bench/drive.mjs --port 9222 --testid new-tab-button \
//         --probe-file bench/probes/popup-anatomy.js --tag t2-menu
// 为什么必须由 drive.mjs 调用:弹层在失焦/停顿后立即关闭,必须"点完当场解剖"。
// 定位思路:弹层没有 ARIA 角色,故按"可见 + 有背景或阴影 + 含多个条目 + 面积最小"挑。

(() => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const st = (e, props) => { const s = getComputedStyle(e); const o = {}; for (const p of props) o[p] = s[p]; return o; };

  const cands = [];
  for (const e of document.querySelectorAll("div,ul,section")) {
    const r = e.getBoundingClientRect();
    if (r.width < 120 || r.width > 720 || r.height < 36 || r.height > 520) continue;
    if (r.top < 20 || r.top > 520 || r.left < 0) continue;
    const s = getComputedStyle(e);
    const hasBg = s.backgroundColor !== "rgba(0, 0, 0, 0)";
    const hasShadow = s.boxShadow !== "none";
    if (!hasBg && !hasShadow) continue;
    const items = [...e.querySelectorAll("*")].filter((x) => {
      const rr = x.getBoundingClientRect();
      return rr.height >= 16 && rr.height <= 64 && rr.width >= 80 && (x.textContent || "").trim().length > 0;
    }).length;
    if (items < 2) continue;
    cands.push({ score: (hasShadow ? 2 : 0) + (hasBg ? 1 : 0), area: r.width * r.height, el: e, items });
  }
  if (!cands.length) return { found: false, note: "未见弹层候选(可能未打开/已关闭)" };

  cands.sort((a, b) => b.score - a.score || a.area - b.area);
  const popup = cands[0].el;

  const items = [...popup.querySelectorAll("*")]
    .filter((e) => {
      const r = e.getBoundingClientRect();
      const txt = (e.textContent || "").replace(/\s+/g, " ").trim();
      return r.height >= 18 && r.height <= 64 && r.width >= 100 && txt.length >= 1 && txt.length <= 70 && e.children.length <= 4;
    })
    .slice(0, 20)
    .map((e) => ({
      tag: e.tagName, box: box(e), text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70),
      hasIcon: !!e.querySelector("svg,img"),
      style: st(e, ["backgroundColor", "color", "fontSize", "fontWeight", "borderRadius", "paddingLeft", "paddingTop", "borderBottom"]),
    }));

  const headings = [...popup.querySelectorAll("*")]
    .filter((e) => { const t = (e.textContent || "").trim(); const r = e.getBoundingClientRect();
      return t.length > 2 && t.length < 30 && e.children.length === 0 && r.height < 22; })
    .slice(0, 6)
    .map((e) => ({ text: e.textContent.trim(), box: box(e), style: st(e, ["color", "fontSize", "fontWeight", "textTransform", "letterSpacing"]) }));

  return {
    found: true,
    candidateCount: cands.length,
    popup: { box: box(popup), style: st(popup, ["backgroundColor", "borderRadius", "boxShadow", "padding", "border", "width", "minWidth"]) },
    fullText: (popup.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240),
    headings,
    items,
  };
})()
