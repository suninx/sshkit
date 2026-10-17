// bench/probes/tabs.js — tab 条结构与样式探针(T2,只读)
//
// 用法:node bench/grab.mjs --port 9222 --url-match primary --eval-file bench/probes/tabs.js
// 目的:把"多 Tab 体系"从肉眼观感变成可复刻的结构:有哪些 tab、哪个是活动态、
//       活动/非活动态的配色与尺寸、关闭按钮与"+"的位置和 aria。
// 说明:原版用 CSS-in-JS(类名带哈希),故不依赖类名,靠 data-testid / role / 结构定位。

(() => {
  const cs = (el, props) => {
    const s = getComputedStyle(el);
    const o = {};
    for (const p of props) o[p] = s[p];
    return o;
  };
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const desc = (el) => ({
    tag: el.tagName,
    testid: el.getAttribute("data-testid"),
    role: el.getAttribute("role"),
    ariaLabel: el.getAttribute("aria-label"),
    ariaSelected: el.getAttribute("aria-selected"),
    title: el.getAttribute("title"),
    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
    box: box(el),
  });

  const strip =
    document.querySelector('[data-testid="horizontal-tabs"]') ||
    document.querySelector('[role="tablist"]') ||
    (() => {
      // 退路:找水平排列、含多个按钮的容器
      const cands = [...document.querySelectorAll("div,ul")]
        .filter((e) => e.querySelectorAll(":scope > button, :scope > * > button").length >= 2)
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter((o) => o.r.top < 60 && o.r.height > 20 && o.r.height < 60);
      return cands.sort((a, b) => a.r.top - b.r.top)[0]?.e ?? null;
    })();

  const out = { stripFound: !!strip, strip: strip ? desc(strip) : null };
  if (!strip) return out;

  const STYLE_PROPS = ["backgroundColor", "color", "borderRadius", "padding", "fontSize", "fontFamily",
    "fontWeight", "borderColor", "borderWidth", "opacity", "height", "lineHeight"];

  // 直接子元素 + 孙元素里像 tab 的
  const candidates = [...strip.querySelectorAll("*")].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 20 && r.height > 16 && r.height < 60 && r.top < 60;
  });
  out.items = candidates.slice(0, 24).map((e) => ({ ...desc(e), style: cs(e, STYLE_PROPS) }));

  // 活动态判定:aria-selected / 视觉差异(背景不同者)
  const active = candidates.filter((e) => e.getAttribute("aria-selected") === "true");
  out.activeByAria = active.map(desc);
  const bgGroups = {};
  for (const e of candidates) {
    const bg = getComputedStyle(e).backgroundColor;
    (bgGroups[bg] ||= []).push((e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 20));
  }
  out.bgGroups = bgGroups;

  const plus = document.querySelector('[data-testid="new-tab-button"]') ||
    [...document.querySelectorAll("button")].find((b) => b.getBoundingClientRect().top < 60 && !(b.textContent || "").trim());
  out.newTabButton = plus ? { ...desc(plus), style: cs(plus, STYLE_PROPS) } : null;
  out.closeButtons = [...strip.querySelectorAll("button")]
    .filter((b) => /close/i.test(b.getAttribute("aria-label") || ""))
    .slice(0, 4)
    .map((b) => ({ ...desc(b), style: cs(b, ["color", "opacity", "width", "height"]) }));

  // 非活动 tab 里是否常显关闭按钮(悬停才显?)
  out.note = "closeButtons 为空说明关闭按钮可能仅悬停时挂载";
  return out;
})()
