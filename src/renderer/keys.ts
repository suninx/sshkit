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
  { id: "serialConnection", name: "Open Serial Connection", accel: "Cmd+Alt+S" },
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

const isTextField = (el: Element | null): boolean =>
  !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);

/** 在输入框里也应当生效的应用级快捷键(其余在输入框内让位给文本编辑) */
const APP_LEVEL = new Set(["openTerminalSearch", "commandPalette", "close", "newTab", "bottom", "top"]);

/**
 * 安装全局快捷键。
 * @param handlers 已实现的动作:actionId → 行为
 * @param onMissing 未实现的动作(用于显式告知,而不是静默吞掉按键)
 */
export function installShortcuts(
  handlers: Record<string, () => void>,
  onMissing: (def: ShortcutDef) => void,
): void {
  const table = MAC_SHORTCUTS
    .map((def) => ({ def, parsed: def.accel ? parseAccel(def.accel) : null }))
    .filter((x): x is { def: ShortcutDef; parsed: Parsed } => x.parsed !== null);

  window.addEventListener(
    "keydown",
    (e) => {
      for (const { def, parsed } of table) {
        if (!matches(e, parsed)) continue;
        if (isTextField(document.activeElement) && !APP_LEVEL.has(def.id)) return;
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
