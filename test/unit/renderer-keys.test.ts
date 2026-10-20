// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAC_SHORTCUTS,
  TERMINAL_SHORTCUTS,
  installShortcuts,
  parseAccel,
} from "../../src/renderer/keys";

/**
 * keys.ts 的行为测试。
 *
 * 规格来源:原版自身配置 `localStorage.shortcut_schemes`(Mac 方案 20 条)+ 主进程 View 菜单加速键。
 * 这里锁的是**可观察行为**:
 *   - 表里的键位真的能派发到对应 handler(不是"表里有这一条"就算数);
 *   - 未实现的键位必须走 onMissing 显式告知,不能静默吞键;
 *   - 输入框焦点语义:编辑键让位、应用级导航键照常;xterm 的辅助 textarea 必须排除
 *     (回归:终端几乎总是有焦点,曾被当成 TEXTAREA 吞掉全部应用级快捷键);
 *   - 捕获阶段优先于 xterm 自己的 keydown 处理(否则部分键永远收不到)。
 */

function key(
  init: KeyboardEventInit & { code: string },
  target: EventTarget = window,
): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

/** 把 "Cmd+Shift+]" 这类加速键转成可派发的 KeyboardEventInit */
function accelInit(accel: string): KeyboardEventInit {
  const p = parseAccel(accel);
  if (!p) throw new Error(`test setup: unparsable accel ${accel}`);
  return { code: p.code, metaKey: p.meta, shiftKey: p.shift, altKey: p.alt, ctrlKey: p.ctrl };
}

type HandlerMap = Record<string, ReturnType<typeof vi.fn>>;

function installWithHandlers(ids: string[]): { handlers: HandlerMap; onMissing: ReturnType<typeof vi.fn> } {
  const handlers: HandlerMap = {};
  for (const id of ids) handlers[id] = vi.fn();
  const onMissing = vi.fn();
  installShortcuts(handlers as unknown as Record<string, () => void>, onMissing);
  return { handlers, onMissing };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("parseAccel", () => {
  it("解析修饰键 + 字母键为 US 键盘 code", () => {
    expect(parseAccel("Cmd+C")).toEqual({ code: "KeyC", meta: true, shift: false, alt: false, ctrl: false });
    expect(parseAccel("Cmd+Shift+M")).toEqual({ code: "KeyM", meta: true, shift: true, alt: false, ctrl: false });
  });

  it("接受 Meta/Option/Control 别名并忽略大小写与空白", () => {
    expect(parseAccel("Meta+Option+Control+X")).toEqual({
      code: "KeyX", meta: true, shift: false, alt: true, ctrl: true,
    });
    expect(parseAccel(" Cmd + shift + s ")).toEqual({
      code: "KeyS", meta: true, shift: true, alt: false, ctrl: false,
    });
    expect(parseAccel("cmd+c")).toEqual({ code: "KeyC", meta: true, shift: false, alt: false, ctrl: false });
  });

  it("把标点映射为 US 布局的物理 code", () => {
    const table: Array<[string, string]> = [
      ["]", "BracketRight"], ["[", "BracketLeft"], [".", "Period"], [",", "Comma"],
      ["-", "Minus"], ["=", "Equal"], ["/", "Slash"], ["\\", "Backslash"], ["`", "Backquote"],
    ];
    for (const [ch, code] of table) {
      expect(parseAccel(`Cmd+${ch}`)?.code, ch).toBe(code);
    }
  });

  it("支持数字键与 F 功能键", () => {
    expect(parseAccel("Cmd+7")?.code).toBe("Digit7");
    expect(parseAccel("Cmd+Shift+F12")?.code).toBe("F12");
  });

  it("空串 / 只有修饰键 / 未知键返回 null(而不是一个永不匹配的假键)", () => {
    for (const bad of ["", "Cmd", "Cmd+Shift", "Cmd+", "Cmd+Hyper", "Cmd+Plus"]) {
      expect(parseAccel(bad), bad).toBeNull();
    }
  });
});

describe("快捷键表", () => {
  it("保留原版 Mac 方案 20 条,顺序/id/默认键位一致", () => {
    expect(MAC_SHORTCUTS.map((s) => s.id)).toEqual([
      "copyFromTerminal", "pasteToTerminal", "selectAllInTerminal", "toggleSidepanel",
      "saveWorkspaceTemplate", "localTerminal", "toggleSplitViewBroadcastMode", "toggleWorkspaceViewMode",
      "serialConnection", "clearTerminalBuffer", "openTerminalSearch", "terminals", "close",
      "snippets", "forwarding", "commandPalette", "jumpTo", "newTab", "bottom", "top",
    ]);
    const byId = new Map(MAC_SHORTCUTS.map((s) => [s.id, s]));
    expect(byId.get("copyFromTerminal")?.accel).toBe("Cmd+C");
    expect(byId.get("forwarding")?.accel).toBe("Cmd+P");
    /* 原版自身这两条就没有默认键位(null 不是漏配) */
    expect(byId.get("clearTerminalBuffer")?.accel).toBeNull();
    expect(byId.get("terminals")?.accel).toBeNull();
  });

  it("终端级字号快捷键来自 View 菜单,共两条", () => {
    expect(TERMINAL_SHORTCUTS.map((s) => s.id)).toEqual(["increaseTerminalFontSize", "decreaseTerminalFontSize"]);
  });

  it("表里所有非空键位都能被 parseAccel 解析(否则该条永远收不到按键)", () => {
    for (const def of [...MAC_SHORTCUTS, ...TERMINAL_SHORTCUTS]) {
      if (def.accel) expect(parseAccel(def.accel), def.id).not.toBeNull();
    }
  });
});

describe("installShortcuts · 派发", () => {
  it("每个已实现键位都能派发到自己的 handler,且不误报未实现", () => {
    const all = [...MAC_SHORTCUTS, ...TERMINAL_SHORTCUTS];
    const { handlers, onMissing } = installWithHandlers(all.map((s) => s.id));
    for (const def of all) {
      if (!def.accel) continue;
      key(accelInit(def.accel));
      expect(handlers[def.id], def.id).toHaveBeenCalledTimes(1);
    }
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("命中时 preventDefault(避免 xterm/浏览器再处理一次),未命中时不抢键", () => {
    const { handlers } = installWithHandlers(["localTerminal"]);
    const hit = key({ code: "KeyL", metaKey: true });
    expect(handlers.localTerminal).toHaveBeenCalledTimes(1);
    expect(hit.defaultPrevented).toBe(true);

    const miss = key({ code: "KeyZ", metaKey: true });
    expect(miss.defaultPrevented).toBe(false);
    expect(handlers.localTerminal).toHaveBeenCalledTimes(1);
  });

  it("修饰键必须完全一致(Cmd+Shift+L 不触发 Cmd+L)", () => {
    const { handlers } = installWithHandlers(["localTerminal"]);
    const ev = key({ code: "KeyL", metaKey: true, shiftKey: true });
    expect(handlers.localTerminal).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("未实现的动作不是静默吞键:preventDefault 后调用 onMissing(带原版名称)", () => {
    const { onMissing } = installWithHandlers([]);
    const ev = key({ code: "KeyJ", metaKey: true });
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onMissing).toHaveBeenCalledWith(expect.objectContaining({ id: "jumpTo", name: "Jump to" }));
    expect(ev.defaultPrevented).toBe(true);
  });

  it("字号:Cmd/Ctrl + = 与轴键 NumpadAdd/NumpadSubtract 都能增减;带 Alt 不触发", () => {
    const { handlers } = installWithHandlers(["increaseTerminalFontSize", "decreaseTerminalFontSize"]);

    key({ code: "Equal", metaKey: true });
    key({ code: "NumpadAdd", metaKey: true });
    key({ code: "Equal", ctrlKey: true });
    expect(handlers.increaseTerminalFontSize).toHaveBeenCalledTimes(3);

    key({ code: "Minus", metaKey: true });
    key({ code: "NumpadSubtract", ctrlKey: true });
    expect(handlers.decreaseTerminalFontSize).toHaveBeenCalledTimes(2);

    key({ code: "Equal", metaKey: true, altKey: true });
    expect(handlers.increaseTerminalFontSize).toHaveBeenCalledTimes(3);
  });

  it("字号 handler 未接线时也走 onMissing,而不是按键没反应", () => {
    const { onMissing } = installWithHandlers([]);
    key({ code: "Equal", metaKey: true });
    expect(onMissing).toHaveBeenCalledWith(expect.objectContaining({ id: "increaseTerminalFontSize" }));
  });

  it("没有 Cmd/Ctrl 时不进入字号分支:普通 = / - 键不被拦截", () => {
    const { handlers, onMissing } = installWithHandlers(["increaseTerminalFontSize", "decreaseTerminalFontSize"]);

    const plainEqual = key({ code: "Equal" });
    const plainMinus = key({ code: "Minus" });
    const shiftEqual = key({ code: "Equal", shiftKey: true });
    expect(plainEqual.defaultPrevented).toBe(false);
    expect(plainMinus.defaultPrevented).toBe(false);
    expect(shiftEqual.defaultPrevented).toBe(false);
    expect(handlers.increaseTerminalFontSize).not.toHaveBeenCalled();
    expect(handlers.decreaseTerminalFontSize).not.toHaveBeenCalled();
    expect(onMissing).not.toHaveBeenCalled();
  });
});

describe("installShortcuts · 焦点语义", () => {
  it("输入框里编辑键让位(不 preventDefault),应用级导航键照常生效", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    const { handlers, onMissing } = installWithHandlers(["saveWorkspaceTemplate", "selectAllInTerminal", "forwarding"]);

    /* Cmd+S / Cmd+A 在文本框里有编辑语义 → 让位,xterm 与浏览器各按各的来 */
    const save = key({ code: "KeyS", metaKey: true }, input);
    const selectAll = key({ code: "KeyA", metaKey: true }, input);
    expect(handlers.saveWorkspaceTemplate).not.toHaveBeenCalled();
    expect(handlers.selectAllInTerminal).not.toHaveBeenCalled();
    expect(save.defaultPrevented).toBe(false);
    expect(selectAll.defaultPrevented).toBe(false);
    expect(onMissing).not.toHaveBeenCalled();

    /* Cmd+P 不是文本编辑键 → 应用级快捷键必须照常生效 */
    const palette = key({ code: "KeyP", metaKey: true }, input);
    expect(handlers.forwarding).toHaveBeenCalledTimes(1);
    expect(palette.defaultPrevented).toBe(true);
  });

  it("回归:xterm 的辅助 textarea 不算表单控件,Cmd+A 仍应全选终端", () => {
    const wrap = document.createElement("div");
    wrap.className = "xterm";
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    wrap.append(ta);
    document.body.append(wrap);
    ta.focus();
    expect(document.activeElement).toBe(ta);

    const { handlers } = installWithHandlers(["selectAllInTerminal", "copyFromTerminal"]);
    const ev = key({ code: "KeyA", metaKey: true }, ta);
    expect(handlers.selectAllInTerminal).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("回归:监听在捕获阶段 —— 子节点的 bubble 监听器 stopPropagation 也拦不住应用快捷键", () => {
    const child = document.createElement("div");
    document.body.append(child);
    child.addEventListener("keydown", (e) => e.stopPropagation());

    const { handlers } = installWithHandlers(["newTab"]);
    key({ code: "KeyT", metaKey: true }, child);
    expect(handlers.newTab).toHaveBeenCalledTimes(1);
  });
});
