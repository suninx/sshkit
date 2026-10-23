/* 跨标签广播输入(secureCRT 的 Send to All Sessions / iTerm2 的 Broadcast Input)。
   纯逻辑放这里,便于单测;app.ts 只负责接 xterm 与渲染。

   安全模型(用户要求"危险命令回车前确认"):
   - 广播组内打字时,可打印字符照常实时发给所有会话(远端会回显);
   - **只扣住回车**:回车时用本地累积的行做危险命令判断,
     命中就弹确认;拒绝时给所有会话发 Ctrl+U 清行,不执行;
   - 本地 shell 不允许加入广播组(避免误伤本机)。 */

/** 命中即需要确认的命令(宁可多问一次,也不要一条命令打穿三台)。
    只看**命令开头**(允许 sudo),避免 `echo rm -rf` 这种误报。 */
const DANGEROUS = /^(?:\s*sudo\s+)?(?:rm\s+-[a-zA-Z]*[rf]|rm\s+--recursive|mkfs(\.\w+)?|dd\s+of=|shutdown|reboot|halt|poweroff|init\s+0|:\(\))/i;

/** 判断一行命令是否危险 */
export function isDangerousCommand(line: string): boolean {
  return DANGEROUS.test(line);
}

export interface BroadcastState {
  /** 在广播组里的会话 id */
  ids: Set<number>;
  /** 每个会话本地累积的当前行(用于回车前的危险判断) */
  lines: Map<number, string>;
}

export const createBroadcastState = (): BroadcastState => ({ ids: new Set(), lines: new Map() });

/** 加入/退出广播组;返回加入后是否在组里 */
export function toggleBroadcast(state: BroadcastState, id: number): boolean {
  if (state.ids.has(id)) {
    state.ids.delete(id);
    state.lines.delete(id);
    return false;
  }
  state.ids.add(id);
  state.lines.set(id, "");
  return true;
}

/** 会话断开/关闭时移出组;返回是否真的移除了 */
export function removeFromBroadcast(state: BroadcastState, id: number): boolean {
  state.lines.delete(id);
  return state.ids.delete(id);
}

export interface WritePlan {
  /** 这次按键要发给哪些会话(空数组 = 不发送) */
  targets: number[];
  /** 是否需要用户确认(危险命令且按了回车) */
  confirm: { line: string } | null;
  /** 确认被拒后需要发给所有目标的"清行"指令 */
  clearOnDeny: boolean;
}

/** 累积本地行:控制字符不参与(方向键、Tab 等会让行内容失真,直接重置更保守) */
function accumulate(prev: string, data: string): string {
  /* 方向键/功能键等 ANSI 序列整块到达:整块丢弃并重置本行(逐字符解析会把 "[D" 当输入) */
  if (data.includes("\x1b")) return "";
  let line = prev;
  for (const ch of data) {
    const code = ch.codePointAt(0)!;   // ch 来自 for...of,非空
    if (ch === "\r" || ch === "\n") continue;
    if (ch === "\x7f" || ch === "\b") { line = line.slice(0, -1); continue; }
    if (code < 32) { line = ""; continue; }
    line += ch;
  }
  return line;
}

/**
 * 计算一次输入该怎么发:
 * - 不在广播组:只发自己
 * - 在广播组且不是回车:发给全组(并累积本地行)
 * - 在广播组且是回车:命中危险命令 → 扣住回车等确认;否则发给全组
 */
export function planWrite(state: BroadcastState, sourceId: number, data: string): WritePlan {
  const inGroup = state.ids.has(sourceId);
  if (!inGroup) return { targets: [sourceId], confirm: null, clearOnDeny: false };

  const targets = [...state.ids];
  const isEnter = data === "\r" || data === "\n";
  if (!isEnter) {
    /* 在组里 ⇔ toggleBroadcast 已给该 id 建过行缓冲 */
    state.lines.set(sourceId, accumulate(state.lines.get(sourceId)!, data));
    return { targets, confirm: null, clearOnDeny: false };
  }

  const line = state.lines.get(sourceId)!.trim();
  state.lines.set(sourceId, "");
  if (line !== "" && isDangerousCommand(line)) {
    return { targets, confirm: { line }, clearOnDeny: true };
  }
  return { targets, confirm: null, clearOnDeny: false };
}

/** 拒绝危险命令时发给终端的清行序列(Ctrl+U:清空当前行) */
export const CLEAR_LINE = "\x15";
