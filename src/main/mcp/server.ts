/* MCP 服务器(Streamable HTTP 传输,spec 2025-06-18):
     POST /mcp    JSON-RPC 请求(initialize / tools/list / tools/call / ping)
     GET  /mcp    SSE 流(服务器→客户端通知;本实现只发 keep-alive)
     DELETE /mcp  结束会话

   为什么自己写而不用 SDK:整条链只需要"请求→工具→结果"这一小段,
   自己实现能省一个运行时依赖,也便于把每次调用直接变成 UI 可渲染的
   McpActivity(用户要求"AI 通过 MCP 操作,但我得看得见")。

   本节不依赖 Electron —— 只吃一个可注入的工具表,所以能用真实 http 端口做单测。 */

import http from "node:http";
import { randomBytes } from "node:crypto";
import {
  MCP_LATEST_PROTOCOL, MCP_PROTOCOL_VERSIONS, MCP_SERVER_NAME,
  type McpActivity, type McpCallStatus, type McpToolDef,
} from "../../shared/mcp";

export interface McpToolResult {
  /** 回给客户端的正文(通常是人类可读/可解析的文本) */
  text: string;
  /** true 表示"工具执行失败",但仍是协议层的正常结果(与 JSON-RPC error 区分) */
  isError?: boolean;
}

export interface McpTool {
  def: McpToolDef;
  run(args: Record<string, unknown>, ctx: { signal: AbortSignal }): Promise<McpToolResult>;
}

export interface McpServerOptions {
  port: number;
  token: string;
  version: string;
  tools: McpTool[];
  /** 每次调用/握手都回调一次,用于 UI 活动流 */
  onActivity: (ev: McpActivity) => void;
  /** 会话增减时回调(渲染层显示"谁连着") */
  onClients: (clients: string[]) => void;
  /** 仅测试用:允许端口 0 自动分配 */
  host?: string;
  /** 标准档:写/执行前先问用户(返回 false = 拒绝执行) */
  approve?: (def: McpToolDef, args: Record<string, unknown>) => Promise<boolean>;
  /** SSE keep-alive 间隔(毫秒;由调用方给常量,测试里调小) */
  pingMs: number;
}

export interface McpServerHandle {
  port: number;
  /** 一键中断:把所有在跑的 tools/call 都 abort(STOP 按钮 / 关服务时用) */
  abortAll: () => void;
  close: () => Promise<void>;
}

type JsonRpcId = string | number | null;

interface Session {
  id: string;
  client: string;
  /** 该会话上打开着的 SSE 流(GET /mcp) */
  streams: Set<http.ServerResponse>;
}

const MAX_BODY = 1 << 20;            // 1MB:JSON-RPC 请求体上限
const ACTIVITY_PREVIEW = 600;        // 活动面板里 args/result 的预览长度

const clip = (text: string, max = ACTIVITY_PREVIEW): string =>
  text.length <= max ? text : `${text.slice(0, max)}…(共 ${text.length} 字符)`;

/** 参数里可能带密码之类 —— 活动面板里打码(凭据本身从不经过 MCP,这里是保险) */
const REDACT_KEYS = /^(password|passphrase|secret|token|privateKey)$/i;
export function redactArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactArgs);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) ? "***" : redactArgs(v);
    }
    return out;
  }
  return value;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: JsonRpcId, result: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, result });

const rpcError = (id: JsonRpcId, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export async function startMcpServer(opts: McpServerOptions): Promise<McpServerHandle> {
  const sessions = new Map<string, Session>();
  /* 正在执行的 tools/call:requestId -> AbortController(取消通知要能找到它) */
  const inflight = new Map<string, AbortController>();
  const toolsByName = new Map(opts.tools.map((t) => [t.def.name, t]));
  let nextActivityId = 1;
  let closed = false;

  /** id 可选:传了就复用(同一次调用的 running→最终状态是一条记录,不是两条) */
  const activity = (ev: Omit<McpActivity, "id" | "at"> & { id?: number }): void => {
    const { id, ...rest } = ev;
    opts.onActivity({ id: id ?? nextActivityId++, at: Date.now(), ...rest });
  };
  const clientList = (): string[] => [...new Set([...sessions.values()].map((s) => s.client))];

  const requireSession = (req: http.IncomingMessage): Session | null => {
    const id = req.headers["mcp-session-id"];
    if (typeof id !== "string" || id === "") return null;
    return sessions.get(id) ?? null;
  };

  const authorized = (req: http.IncomingMessage): boolean => {
    const h = req.headers.authorization;
    if (typeof h !== "string") return false;
    return h === `Bearer ${opts.token}`;
  };

  /** 处理一条 JSON-RPC 消息:返回要写回的 body(null 表示"只回状态码") */
  const handleMessage = async (
    msg: RpcRequest,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<{ body: string | null; status: number; sessionId?: string }> => {
    const id = msg.id ?? null;
    const isNotification = msg.id === undefined;
    const params = msg.params ?? {};

    /* ---- 握手 ---- */
    if (msg.method === "initialize") {
      const wanted = String((params.protocolVersion as string | undefined) ?? "");
      const negotiated = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(wanted)
        ? wanted : MCP_LATEST_PROTOCOL;
      const info = (params.clientInfo ?? {}) as { name?: string; version?: string };
      const client = [info.name, info.version].filter(Boolean).join(" ") || "unknown";
      const sessionId = randomBytes(16).toString("hex");
      sessions.set(sessionId, { id: sessionId, client, streams: new Set() });
      activity({ client, method: "initialize", tool: "-", status: "ok",
        args: clip(JSON.stringify(redactArgs(params))) });
      opts.onClients(clientList());
      return {
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: opts.version },
        }),
        status: 200,
        sessionId,
      };
    }

    /* ---- 通知:不需要会话,也没有响应体 ---- */
    if (isNotification) {
      if (msg.method === "notifications/cancelled") {
        const target = params.requestId;
        const ctl = inflight.get(String(target));
        if (ctl) ctl.abort();
      }
      return { body: null, status: 202 };
    }

    /* ---- 其余请求都要求有效会话 ---- */
    const session = requireSession(req);
    if (!session) {
      return { body: rpcError(id, -32000, "session not found"), status: 404 };
    }

    if (msg.method === "ping") return { body: rpcResult(id, {}), status: 200 };

    if (msg.method === "tools/list") {
      const tools: McpToolDef[] = opts.tools.map((t) => t.def);
      activity({ client: session.client, method: "tools/list", tool: "-", status: "ok" });
      return { body: rpcResult(id, { tools }), status: 200 };
    }

    if (msg.method === "tools/call") {
      const name = String((params.name as string | undefined) ?? "");
      const tool = toolsByName.get(name);
      if (!tool) return { body: rpcError(id, -32602, `unknown tool: ${name}`), status: 200 };

      const args = (params.arguments ?? {}) as Record<string, unknown>;
      /* 标准档:写/执行类工具先问用户;拒绝就不执行(不是超时,是明确拒绝) */
      if (tool.def.kind !== "read" && opts.approve) {
        const allowed = await opts.approve(tool.def, args);
        if (!allowed) {
          activity({ client: session.client, method: "tools/call", tool: name, status: "error",
            args: clip(JSON.stringify(redactArgs(args))), error: "denied by user" });
          return {
            body: rpcResult(id, { content: [{ type: "text", text: "Denied by user (sshkit MCP approval)" }], isError: true }),
            status: 200,
          };
        }
      }
      const started = Date.now();
      const ctl = new AbortController();
      const key = String(id);
      const callId = nextActivityId++;
      const argsPreview = clip(JSON.stringify(redactArgs(args)));
      inflight.set(key, ctl);
      activity({ id: callId, client: session.client, method: "tools/call", tool: name, status: "running",
        args: argsPreview });
      const finish = (status: McpCallStatus, extra: Partial<McpActivity> = {}): void => {
        /* 最终状态也要带上参数:UI 原地更新那一行时,标题里的 host/path 不能丢 */
        activity({ id: callId, client: session.client, method: "tools/call", tool: name, status,
          args: argsPreview, ms: Date.now() - started, ...extra });
      };
      try {
        const result = await tool.run(args, { signal: ctl.signal });
        finish("ok", { result: clip(result.text) });
        return {
          body: rpcResult(id, {
            content: [{ type: "text", text: result.text }],
            ...(result.isError ? { isError: true } : {}),
          }),
          status: 200,
        };
      } catch (err) {
        if (ctl.signal.aborted) {
          finish("cancelled");
          return { body: rpcError(id, -32800, "request cancelled"), status: 200 };
        }
        const msg2 = String((err as Error)?.message ?? err);
        finish("error", { error: clip(msg2) });
        /* 工具执行失败按 MCP 约定放进 result(isError),客户端能拿到错误文本 */
        return {
          body: rpcResult(id, { content: [{ type: "text", text: msg2 }], isError: true }),
          status: 200,
        };
      } finally {
        inflight.delete(key);
      }
    }

    return { body: rpcError(id, -32601, `method not found: ${msg.method}`), status: 200 };
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      /* node 的 http 请求一定有 url(即使为空也是字符串),不需要兜底分支 */
      const url = new URL(req.url as string, "http://127.0.0.1");
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (!authorized(req)) {
        res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="sshkit mcp"' })
          .end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (req.method === "GET") {
        /* SSE:保持连接,定期 keep-alive;客户端断开就收尾 */
        const session = requireSession(req);
        if (!session) { res.writeHead(404).end(); return; }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        session.streams.add(res);
        const timer = setInterval(() => res.write(": ping\n\n"), opts.pingMs);
        req.on("close", () => { clearInterval(timer); session.streams.delete(res); });
        return;
      }

      if (req.method === "DELETE") {
        const session = requireSession(req);
        if (!session) { res.writeHead(404).end(); return; }
        for (const s of session.streams) s.end();
        sessions.delete(session.id);
        opts.onClients(clientList());
        res.writeHead(204).end();
        return;
      }

      if (req.method !== "POST") { res.writeHead(405).end(); return; }

      let raw: string;
      try {
        raw = await readBody(req);
      } catch (err) {
        /* readBody 只在超出 1MB 时 reject —— 原因固定 */
        res.writeHead(413).end(rpcError(null, -32700, "request body too large"));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
          .end(rpcError(null, -32700, "parse error"));
        return;
      }
      if (Array.isArray(parsed) || !parsed || typeof parsed !== "object") {
        /* 2025-06-18 起 JSON-RPC 批处理已移除 */
        res.writeHead(400, { "Content-Type": "application/json" })
          .end(rpcError(null, -32600, "invalid request"));
        return;
      }

      const out = await handleMessage(parsed as RpcRequest, req, res);
      const headers: Record<string, string> = {};
      if (out.sessionId) headers["Mcp-Session-Id"] = out.sessionId;
      if (out.body === null) { res.writeHead(out.status, headers).end(); return; }
      headers["Content-Type"] = "application/json";
      res.writeHead(out.status, headers).end(out.body);
    })().catch(() => {
      /* 兜底:内部错误(例如 UI 回调抛异常)不能让进程崩,直接掐掉这次请求的响应 */
      res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  return {
    port,
    abortAll: () => { for (const ctl of inflight.values()) ctl.abort(); },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const s of sessions.values()) for (const stream of s.streams) stream.end();
      sessions.clear();
      inflight.clear();
      /* HTTP keep-alive 的连接不会自己消失 —— 不主动断开会卡住 close(重启/换端口时很明显) */
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
