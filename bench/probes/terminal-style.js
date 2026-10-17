// bench/probes/terminal-style.js — 终端渲染规格探针(双侧同用,只读)
//
// 用法:node bench/grab.mjs --port 9222 --eval-file bench/probes/terminal-style.js
// 目的:T1 的"字体/配色/尺寸"要数字,不要"看着挺像"。
// 两侧都是 xterm.js(原版亦为 xterm 血统),故优先按 .xterm 家族取;取不到再退到正文。

(() => {
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const x = document.querySelector(".xterm");
  const screen_ = document.querySelector(".xterm-screen");
  const rowsEl = document.querySelector(".xterm-rows");
  const helper = document.querySelector(".xterm-helper-textarea");
  const cm = document.querySelector(".xterm-char-measure-element"); // xterm 真正量字体用的元素
  const firstRow = rowsEl?.firstElementChild ?? null;
  const csRow = cs(firstRow);
  const csX = cs(x);
  const csCm = cs(cm);
  // xterm 的测量元素内容是若干个 'W';按实际字符数除,得到单字符格尺寸
  const cmLen = cm ? (cm.textContent || "").length : 0;
  const cmBox = cm ? cm.getBoundingClientRect() : null;

  // 终端里一行文字:优先 DOM 渲染器;canvas 渲染器时 DOM 无字,只能靠截图
  const rowText = rowsEl ? rowsEl.innerText.replace(/\u00a0/g, " ").split("\n").slice(0, 3) : null;

  return {
    hasXterm: !!x,
    xtermClasses: x ? String(x.className).slice(0, 120) : null,
    renderer: {
      domRows: !!rowsEl,
      rowCount: rowsEl ? rowsEl.children.length : 0,
      canvases: document.querySelectorAll(".xterm canvas").length,
      layers: document.querySelectorAll(".xterm-screen > div").length,
    },
    font: x
      ? {
          family: csX.fontFamily,
          size: csX.fontSize,
          weight: csX.fontWeight,
          lineHeight: csX.lineHeight,
          helperFamily: helper ? cs(helper).fontFamily : null,
          helperSize: helper ? cs(helper).fontSize : null,
        }
      : null,
    // 终端**真正**用的字体与字符格尺寸(取自 xterm 的测量元素)
    measured: cm
      ? {
          family: csCm.fontFamily,
          size: csCm.fontSize,
          weight: csCm.fontWeight,
          sampleChars: cmLen,
          cellW: cmLen && cmBox ? +(cmBox.width / cmLen).toFixed(3) : null,
          cellH: cmBox ? +cmBox.height.toFixed(3) : null,
        }
      : null,
    colors: {
      containerBg: csX?.backgroundColor ?? null,
      containerColor: csX?.color ?? null,
      rowColor: csRow?.color ?? null,
      rowBg: csRow?.backgroundColor ?? null,
      bodyBg: cs(document.body)?.backgroundColor ?? null,
      bodyColor: cs(document.body)?.color ?? null,
    },
    geometry: {
      window: { iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio },
      xterm: box(x),
      screen: box(screen_),
      // 由屏幕宽/高与行列数反推单字符格尺寸(两侧可比的关键数字)
      cell: rowsEl && rowsEl.children.length
        ? (() => {
            const r0 = rowsEl.firstElementChild?.getBoundingClientRect();
            return r0 ? { w: +(r0.width).toFixed(2), h: +(r0.height).toFixed(2) } : null;
          })()
        : null,
    },
    rowText,
    bodyTextHead: document.body.innerText.replace(/\u00a0/g, " ").replace(/\s+/g, " ").slice(0, 200),
  };
})()
