/* T4 复刻 —— 快捷键表。
   规格**逐条取自原版自身的 `localStorage.shortcut_schemes`**(Mac 方案 20 条),
   id/name/键位原样保留,便于逐项对照"哪些已实现、哪些还没有"。
   未实现的条目不是静默失败,而是显式告知(见 app.ts 的 toast)。 */

export interface ShortcutDef {
  /** 原版 `type` 字段,原样保留 */
  id: string;
  /** 原版 `actionName`,原样保留 */
  name: string;
  /** 原版 Mac 方案默认键位;null = 原版本身也未设默认键 */
  accel: string | null;
}

/** 原版 "Mac hotkeys" 20 条(顺序亦与原版一致) */
export const MAC_SHORTCUTS: ShortcutDef[] = [
  { id: "copyFromTerminal", name: "Copy from Terminal", accel: "Cmd+C" },
  { id: "pasteToTerminal", name: "Paste to Terminal", accel: "Cmd+V" },
  { id: "selectAllInTerminal", name: "Select All in Terminal", accel: "Cmd+A" },
  { id: "toggleSidepanel", name: "Show Terminal Side-panel", accel: "Cmd+." },
  { id: "saveWorkspaceTemplate", name: "Save Workspace Template", accel: "Cmd+S" },
  { id: "localTerminal", name: "Open Local Terminal", accel: "Cmd+L" },
  { id: "toggleSplitViewBroadcastMode", name: "Switch the Broadcast Mode", accel: "Cmd+B" },
  { id: "toggleWorkspaceViewMode", name: "Toggle Workspace View Mode", accel: "Cmd+Shift+M" },
  { id: "clearTerminalBuffer", name: "Clear Terminal Buffer", accel: null },
  { id: "openTerminalSearch", name: "Open Terminal Search", accel: "Cmd+F" },
  { id: "terminals", name: "Open Hosts Page", accel: null },
  { id: "close", name: "Close Tab", accel: "Cmd+W" },
  { id: "snippets", name: "Open Snippets", accel: "Cmd+Shift+S" },
  { id: "forwarding", name: "Open Port Forwarding", accel: "Cmd+P" },
  { id: "commandPalette", name: "Open Command Palette", accel: "Cmd+K" },
  { id: "jumpTo", name: "Jump to", accel: "Cmd+J" },
  { id: "newTab", name: "New tab", accel: "Cmd+T" },
  { id: "bottom", name: "Next Tab", accel: "Cmd+Shift+]" },
  { id: "top", name: "Previous Tab", accel: "Cmd+Shift+[" },
];

/** 终端级快捷键。**来源不同**于上面那 20 条(那是应用自身的 shortcut_schemes):
    这些取自原版**主进程的 View 菜单加速键**(F25):
      Increase terminal font size → CmdOrCtrl+Plus
      Decrease terminal font size → CmdOrCtrl+-
      Reset terminal font size to default → 无加速键(仅菜单项)
    实现上 `Cmd+=` 也一并接受(US 布局上 + 需要 Shift,macOS 用户实际按的多是 Cmd+=)。 */
export const TERMINAL_SHORTCUTS: ShortcutDef[] = [
  { id: "increaseTerminalFontSize", name: "Increase terminal font size", accel: "Cmd+=" },
  { id: "decreaseTerminalFontSize", name: "Decrease terminal font size", accel: "Cmd+-" },
];

interface Parsed {
  code: string;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

const CODE_FOR: Record<string, string> = {
  "]": "BracketRight", "[": "BracketLeft", ".": "Period", ",": "Comma", "-": "Minus",
  "=": "Equal", "/": "Slash", "\\": "Backslash", "`": "Backquote",
};

export function parseAccel(accel: string): Parsed | null {
  const parts = accel.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: Parsed = { code: "", meta: false, shift: false, alt: false, ctrl: false };
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === "cmd" || low === "meta") out.meta = true;
    else if (low === "shift") out.shift = true;
    else if (low === "alt" || low === "option") out.alt = true;
    else if (low === "ctrl" || low === "control") out.ctrl = true;
    else if (/^[a-z]$/.test(low)) out.code = `Key${low.toUpperCase()}`;
    else if (/^[0-9]$/.test(low)) out.code = `Digit${low}`;
    else if (CODE_FOR[p]) out.code = CODE_FOR[p];
    else if (/^f[0-9]{1,2}$/.test(low)) out.code = `F${low.slice(1)}`;
    else return null;
  }
  return out.code ? out : null;
}

function matches(e: KeyboardEvent, p: Parsed): boolean {
  return (
    e.code === p.code &&
    e.metaKey === p.meta &&
    e.shiftKey === p.shift &&
    e.altKey === p.alt &&
    e.ctrlKey === p.ctrl
  );
}

/** 在输入框里也应当生效的应用级快捷键。
    判据:该组合在文本编辑里**没有**既有语义(Cmd+P/Cmd+L/Cmd+K 都不是输入框的标准编辑键),
    故放行;而 Cmd+A/C/V/C 在输入框里有标准语义,必须让位,否则会破坏正常输入。 */
const APP_LEVEL = new Set([
  "openTerminalSearch", "commandPalette", "close", "newTab", "bottom", "top",
  "forwarding", "localTerminal", "terminals",
]);

/**
 * 安装全局快捷键。
 * @param handlers 已实现的动作:actionId → 行为
 * @param onMissing 未实现的动作(用于显式告知,而不是静默吞掉按键)
 */
/** 焦点是否落在真正的表单控件上(排除 xterm 的辅助 textarea)。 */
function inFormField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.closest?.(".xterm")) return false;   // 终端:应用级快捷键必须照常生效
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

export function installShortcuts(
  handlers: Record<string, () => void>,
  onMissing: (def: ShortcutDef) => void,
): void {
  const table = [...MAC_SHORTCUTS, ...TERMINAL_SHORTCUTS]
    .map((def) => ({ def, parsed: def.accel ? parseAccel(def.accel) : null }))
    .filter((x): x is { def: ShortcutDef; parsed: Parsed } => x.parsed !== null);

  /** 字号键在 US 布局上 + 与 = 同键:两者都接受(原版是菜单加速键 Plus/Minus) */
  const fontKey = (e: KeyboardEvent, dir: "up" | "down"): boolean => {
    if (!e.metaKey && !e.ctrlKey) return false;
    if (e.altKey) return false;
    return dir === "up" ? (e.code === "Equal" || e.code === "NumpadAdd") : (e.code === "Minus" || e.code === "NumpadSubtract");
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (fontKey(e, "up") && handlers.increaseTerminalFontSize) { e.preventDefault(); handlers.increaseTerminalFontSize(); return; }
      if (fontKey(e, "down") && handlers.decreaseTerminalFontSize) { e.preventDefault(); handlers.decreaseTerminalFontSize(); return; }

      for (const { def, parsed } of table) {
        if (!matches(e, parsed)) continue;
        /* 焦点在"真正的表单控件"里时不要抢键(否则在搜索框里按 Cmd+W 会关掉 tab)。
           但**必须把终端自身的辅助 textarea 排除** —— xterm 靠一个隐藏 textarea 收键盘,
           它也算 TEXTAREA,于是"终端有焦点"时所有应用级快捷键都被吞掉:
           实测 cmd+. / cmd+shift+m / cmd+j / cmd+shift+s 全不响应,连 cmd+c 复制终端内容、
           cmd+a 全选终端都失效(终端几乎总是有焦点,等于这些键从来没生效过)。 */
        if (inFormField() && !APP_LEVEL.has(def.id)) return;
        e.preventDefault();
        const run = handlers[def.id];
        if (run) run();
        else onMissing(def);
        return;
      }
    },
    true, // 捕获阶段:xterm 会吞掉部分按键,必须先于它处理
  );
}
