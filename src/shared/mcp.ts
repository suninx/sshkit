/* MCP(Model Context Protocol)对外能力:sshkit 当 **MCP 服务器**,
   让 Claude Code / Codex / IDEA+Junie 这类客户端通过它操作远端主机。

   设计要点:凭据永不经过 MCP —— 客户端只传 hostId/host 名,
   密码/私钥仍由主进程从系统钥匙串取。渲染层只负责"看见"每次调用。 */

/** 默认监听端口(只绑 127.0.0.1) */
export const MCP_DEFAULT_PORT = 7788;

/** 端口被占用时最多往后试几个(再不行交给系统分配随机端口) */
export const MCP_PORT_FALLBACKS = 9;

/** 启动时依次尝试的端口:配置端口 → 其后 9 个 → 0(系统分配)。
    纯函数,便于单测"占用时顺延"的行为。 */
export function mcpPortCandidates(configured: number): number[] {
  const list: number[] = [];
  for (let i = 0; i <= MCP_PORT_FALLBACKS; i++) list.push(configured + i);
  list.push(0);
  return list;
}

/** 支持的 MCP 协议版本(新→旧)。协商时优先用客户端要的,不支持就给最新。 */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_LATEST_PROTOCOL = MCP_PROTOCOL_VERSIONS[0];

/** 服务器自报身份(initialize 的 serverInfo) */
export const MCP_SERVER_NAME = "sshkit";

export type McpToolKind = "read" | "write" | "exec";

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  kind: McpToolKind;
  /** JSON Schema(object) */
  inputSchema: Record<string, unknown>;
}

export type McpCallStatus = "running" | "ok" | "error" | "cancelled";

/** 一次 MCP 调用的可视化记录(渲染层按它渲染活动面板) */
export interface McpActivity {
  id: number;
  /** epoch 毫秒 */
  at: number;
  /** 客户端标识,如 "Claude Code 2.0.1";握手前是 "unknown" */
  client: string;
  method: string;
  /** tools/call 时是工具名;其它方法为 "-" */
  tool: string;
  status: McpCallStatus;
  ms?: number;
  /** 参数(已脱敏、已截断) */
  args?: string;
  /** 结果预览(已截断) */
  result?: string;
  error?: string;
}

export interface McpStatus {
  running: boolean;
  /** 实际监听端口(未启动时是配置值) */
  port: number;
  /** 本地访问令牌;客户端配置里要带上 */
  token: string;
  /** 当前权限档 */
  policy: McpPolicy;
  /** 配置端口被占用、实际用了别的端口时,记录原配置值(否则 null) */
  portFallbackFrom: number | null;
  /** 已建立会话的客户端名 */
  clients: string[];
  error: string | null;
  /** 最近的活动(新→旧),渲染层首次打开面板时没有事件流也能看到历史 */
  activity: McpActivity[];
}

/** 三档权限:只读 / 标准(写与执行需你点"允许")/ 全自动 */
export type McpPolicy = "read-only" | "standard" | "full";

export interface McpSettings {
  enabled: boolean;
  port: number;
  policy: McpPolicy;
}

/** ssh_exec 的实时回放事件(渲染层据此开一个可见的"AI 执行"标签页) */
export interface McpExecEvent {
  id: string;
  hostName: string;
  command: string;
  /** 增量输出 */
  chunk?: string;
  stream?: "out" | "err";
  /** 结束事件 */
  done?: boolean;
  exitCode?: number;
}

/** 标准档下,写/执行前的批准请求 */
export interface McpApprovalRequest {
  id: string;
  tool: string;
  args: string;
}

/** SSE keep-alive 间隔(15s:足够让代理/客户端保持连接,又不会吵) */
export const MCP_SSE_PING_MS = 15_000;

/** 活动面板最多保留多少条(内存里;不落盘免得越滚越大) */
export const MCP_ACTIVITY_LIMIT = 200;
