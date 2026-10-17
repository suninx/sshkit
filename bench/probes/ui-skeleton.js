// bench/probes/ui-skeleton.js — 通用 UI 骨架探针(双侧同用,只读)
//
// 用法:node bench/grab.mjs --port 9222 --eval-file bench/probes/ui-skeleton.js
// 目的:把"界面上有什么"变成可 diff 的结构,而不是靠肉眼看截图。
// 对 T1/T2/T3/T4(主题、Tab、转发、快捷键)的规格提取都从这份骨架起步。

(() => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const q = (sel) => [...document.querySelectorAll(sel)];
  return {
    counts: {
      buttons: q("button").length,
      inputs: q("input,textarea").length,
      testids: q("[data-testid]").length,
      svg: q("svg").length,
      nodes: document.querySelectorAll("*").length,
    },
    testids: q("[data-testid]").map((e) => ({
      id: e.dataset.testid,
      tag: e.tagName,
      text: norm(e.textContent).slice(0, 40),
    })),
    buttons: q("button").map((e) => ({
      text: norm(e.textContent).slice(0, 40),
      aria: e.getAttribute("aria-label"),
      testid: e.dataset.testid || null,
      disabled: !!e.disabled,
    })),
    inputs: q("input,textarea").map((e) => ({
      ph: e.placeholder || null,
      type: e.type,
      testid: e.dataset.testid || null,
    })),
    aria: q("[aria-label]").map((e) => ({
      aria: e.getAttribute("aria-label"),
      tag: e.tagName,
      role: e.getAttribute("role"),
    })),
    // 左栏/导航类容器:原版是 sidebar,我方是 aside —— 两边都抓,再人工对齐
    navish: q("nav,[role=navigation],aside,[class*=sidebar i],[class*=nav i]")
      .slice(0, 12)
      .map((e) => ({
        tag: e.tagName,
        cls: String(e.className).slice(0, 60),
        text: norm(e.innerText).slice(0, 160),
      })),
    theme: {
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      colorScheme: getComputedStyle(document.body).colorScheme,
      prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    },
    bodyText: norm(document.body.innerText).slice(0, 800),
  };
})()
