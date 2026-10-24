/* MCP 服务器协议层:用**真实 http 端口**测(不是 mock socket),
   这样 Streamable HTTP 的头部/会话/通知语义都是真跑一遍。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMcpServer, redactArgs, type McpServerHandle, type McpTool } from "../../src/main/mcp/server";
import type { McpActivity } from "../../src/shared/mcp";

const TOKEN = "test-token";
const BASE_TOOL: McpTool = {
  def: {
    name: "echo", title: "Echo", description: "echo back", kind: "read",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  async run(args) { return { text: `echo:${String(args.text)}` } },
};

interface Harness { port: number; activities: McpActivity[]; clients: string[][]; handle: McpServerHandle }

const starts: McpServerHandle[] = [];

async function boot(tools: McpTool[] = [BASE_TOOL], onActivity?: (ev: McpActivity) => void, pingMs = 60_000): Promise<Harness> {
  const activities: McpActivity[] = [];
  const clients: string[][] = [];
  const handle = await startMcpServer({
    port: 0, token: TOKEN, version: "9.9.9", tools, pingMs,
    onActivity: (ev) => { activities.push(ev); onActivity?.(ev); },
    onClients: (c) => clients.push(c),
  });
  starts.push(handle);
  return { port: handle.port, activities, clients, handle };
}

const rpc = async (port: number, body: unknown, opts: { session?: string; token?: string | null } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (opts.session) headers["mcp-session-id"] = opts.session;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text === "" ? null : JSON.parse(text) };
};

const init = async (port: number, clientInfo = { name: "Claude Code", version: "2.0" }, protocolVersion = "2025-06-18") => {
  const r = await rpc(port, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, clientInfo } });
  return { ...r, session: r.headers.get("mcp-session-id") ?? "" };
};

afterEach(async () => {
  while (starts.length) await starts.pop()!.close();
});

describe("MCP 服务器:鉴权与路由", () => {
  it("没有/错误 token → 401;别的路径 → 404", async () => {
    const h = await boot();
    expect((await rpc(h.port, { jsonrpc: "2.0", id: 1, method: "ping" }, { token: null })).status).toBe(401);
    expect((await rpc(h.port, { jsonrpc: "2.0", id: 1, method: "ping" }, { token: "wrong" })).status).toBe(401);
    const res = await fetch(`http://127.0.0.1:${h.port}/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("initialize:回协商后的协议版本 + 会话头;不支持的版本回落到最新", async () => {
    const h = await boot();
    const ok = await init(h.port);
    expect(ok.status).toBe(200);
    expect(ok.session).toMatch(/^[0-9a-f]{32}$/);
    expect(ok.body.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "sshkit", version: "9.9.9" },
      capabilities: { tools: { listChanged: false } },
    });
    expect(h.clients.at(-1)).toEqual(["Claude Code 2.0"]);

    const old = await init(h.port, { name: "x" }, "2099-01-01");
    expect(old.body.result.protocolVersion).toBe("2025-06-18");
    expect(h.clients.at(-1)).toContain("x");
  });

  it("通知:initialized 回 202 无响应体;未知会话 → 404", async () => {
    const h = await boot();
    const n = await rpc(h.port, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(n.status).toBe(202);
    expect(n.body).toBeNull();
    const bad = await rpc(h.port, { jsonrpc: "2.0", id: 2, method: "ping" }, { session: "deadbeef" });
    expect(bad.status).toBe(404);
    expect(bad.body.error.code).toBe(-32000);
  });

  it("ping / tools/list / 未知方法", async () => {
    const h = await boot();
    const { session } = await init(h.port);
    expect((await rpc(h.port, { jsonrpc: "2.0", id: 2, method: "ping" }, { session })).body.result).toEqual({});
    const list = await rpc(h.port, { jsonrpc: "2.0", id: 3, method: "tools/list" }, { session });
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);
    const unknown = await rpc(h.port, { jsonrpc: "2.0", id: 4, method: "resources/list" }, { session });
    expect(unknown.body.error.code).toBe(-32601);
  });

  it("畸形请求:非法 JSON / 批处理 / 非对象 / 超大 body", async () => {
    const h = await boot();
    const authed = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const bad = await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST", headers: authed, body: "{oops" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);

    const batch = await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST", headers: authed, body: "[]" });
    expect(batch.status).toBe(400);
    expect((await batch.json()).error.code).toBe(-32600);

    const scalar = await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "POST", headers: authed, body: "5" });
    expect(scalar.status).toBe(400);

    const huge = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: "POST", headers: authed, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(1_200_000) }),
    }).catch(() => null);
    /* 超限时服务端直接掐连接:客户端要么拿到 413,要么连接被重置 —— 两者都算被拒 */
    if (huge) expect([413, 400]).toContain(huge.status);
  });

  it("PUT/DELETE/GET 的边界", async () => {
    const h = await boot();
    const authed = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "PUT", headers: authed })).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "DELETE", headers: authed })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${h.port}/mcp`, { method: "GET", headers: authed })).status).toBe(404);
  });
});

describe("MCP 服务器:工具调用", () => {
  it("正常调用:结果进 content,活动流有 running→ok", async () => {
    const h = await boot();
    const { session } = await init(h.port);
    const r = await rpc(h.port, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }, { session });
    expect(r.body.result).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
    const acts = h.activities.filter((a) => a.tool === "echo");
    expect(acts.map((a) => a.status)).toEqual(["running", "ok"]);
    /* 同一次调用的两条活动共用一个 id(UI 靠它原地更新) */
    expect(acts[0].id).toBe(acts[1].id);
    expect(acts[0].client).toBe("Claude Code 2.0");
    expect(acts[0].args).toContain("hi");
    expect(typeof acts[1].ms).toBe("number");
  });

  it("isError 结果原样带回;未知工具 -32602;执行抛错变成 isError 文本", async () => {
    const failing: McpTool = {
      def: { ...BASE_TOOL.def, name: "boom", description: "always fails" },
      async run() { throw new Error("disk full"); },
    };
    const flagged: McpTool = {
      def: { ...BASE_TOOL.def, name: "flag" },
      async run() { return { text: "binary file", isError: true }; },
    };
    const h = await boot([BASE_TOOL, failing, flagged]);
    const { session } = await init(h.port);
    const unknown = await rpc(h.port, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } }, { session });
    expect(unknown.body.error.code).toBe(-32602);
    const boom = await rpc(h.port, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "boom" } }, { session });
    expect(boom.body.result.isError).toBe(true);
    expect(boom.body.result.content[0].text).toBe("disk full");
    expect(h.activities.at(-1)).toMatchObject({ tool: "boom", status: "error", error: "disk full" });
    const flag = await rpc(h.port, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "flag" } }, { session });
    expect(flag.body.result.isError).toBe(true);
  });

  it("取消:notifications/cancelled 让在跑的调用 abort", async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    const slow: McpTool = {
      def: { ...BASE_TOOL.def, name: "slow" },
      run: (_a, ctx) => new Promise((_resolve, reject) => {
        started();
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    };
    const h = await boot([slow]);
    const { session } = await init(h.port);
    const callP = rpc(h.port, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "slow" } }, { session });
    await startedP;
    await rpc(h.port, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 11 } }, { session });
    const r = await callP;
    expect(r.body.error.code).toBe(-32800);
    expect(h.activities.at(-1)).toMatchObject({ tool: "slow", status: "cancelled" });
  });

  it("参数里的敏感字段在活动流里打码", async () => {
    const h = await boot();
    const { session } = await init(h.port);
    await rpc(h.port, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "echo", arguments: { text: "x", password: "p@ss", nested: { token: "t" } } } }, { session });
    const act = h.activities.find((a) => a.tool === "echo")!;
    expect(act.args).toContain("***");
    expect(act.args).not.toContain("p@ss");
  });

  it("initialize 不带 clientInfo:客户端名回落到 unknown;未知 requestId 的取消是安全的 no-op", async () => {
    const h = await boot();
    const r = await rpc(h.port, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(r.body.result.protocolVersion).toBe("2025-06-18");
    expect(h.clients.at(-1)).toEqual(["unknown"]);
    const session = r.headers.get("mcp-session-id") as string;
    const cancelled = await rpc(h.port, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9999 } }, { session });
    expect(cancelled.status).toBe(202);
  });

  it("工具抛非 Error 值(字符串):错误文本仍然可读", async () => {
    const weird: McpTool = {
      def: { ...BASE_TOOL.def, name: "weird" },
      async run() { throw "plain string"; },
    };
    const h = await boot([weird]);
    const { session } = await init(h.port);
    const r = await rpc(h.port, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "weird" } }, { session });
    expect(r.body.result).toMatchObject({ isError: true, content: [{ type: "text", text: "plain string" }] });
  });

  it("tools/call 不带 name → 参数错误(-32602)", async () => {
    const h = await boot();
    const { session } = await init(h.port);
    const r = await rpc(h.port, { jsonrpc: "2.0", id: 3, method: "tools/call", params: {} }, { session });
    expect(r.body.error.code).toBe(-32602);
  });

  it("活动回调抛错 → 连接被掐断(不会把进程带崩)", async () => {
    /* 第一次回调(initialize)放行,第二次(tools/list)抛 —— 才能拿到有效会话再触发 500 */
    let calls = 0;
    const h = await boot([BASE_TOOL], () => {
      calls += 1;
      if (calls >= 2) throw new Error("ui exploded");
    });
    const { session } = await init(h.port);
    await expect(rpc(h.port, { jsonrpc: "2.0", id: 13, method: "tools/list" }, { session })).rejects.toThrow();
  });
});

describe("MCP 服务器:SSE 与关闭", () => {
  it("GET /mcp 打开 SSE 流并收到 keep-alive;DELETE 结束会话", async () => {
    const h = await boot();
    const { session } = await init(h.port);
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": session, accept: "text/event-stream" },
      signal: ctl.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("connected");
    /* 关闭服务端 → 流结束(不会挂死) */
    await h.handle.close();
    starts.splice(starts.indexOf(h.handle), 1);
    ctl.abort();
    expect((await rpc(h.port, { jsonrpc: "2.0", id: 14, method: "ping" }, { session }).catch(() => ({ status: 0 }))).status).toBe(0);
  });

  it("SSE 会收到 keep-alive;DELETE 会结束已打开的流", async () => {
    const h = await boot([BASE_TOOL], undefined, 20);
    const { session } = await init(h.port);
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": session, accept: "text/event-stream" },
      signal: ctl.signal,
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = dec.decode((await reader.read()).value);
    /* 等一个 keep-alive(20ms 间隔) */
    for (let i = 0; i < 40 && !buf.includes("ping"); i++) {
      const next = await reader.read();
      if (next.done) break;
      buf += dec.decode(next.value);
    }
    expect(buf).toContain("ping");
    /* DELETE 后流应结束 */
    const del = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: "DELETE", headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": session },
    });
    expect(del.status).toBe(204);
    const after = await reader.read();
    expect(after.done).toBe(true);
    ctl.abort();
  });

  it("DELETE 会话后该会话不再可用;close 可重复调用", async () => {
    const h = await boot();
    const { session } = await init(h.port);
    const del = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: "DELETE", headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": session },
    });
    expect(del.status).toBe(204);
    expect((await rpc(h.port, { jsonrpc: "2.0", id: 15, method: "ping" }, { session })).status).toBe(404);
    await h.handle.close();
    await h.handle.close();
    starts.splice(starts.indexOf(h.handle), 1);
  });
});

describe("参数脱敏", () => {
  it("数组/嵌套对象/大小写不敏感", () => {
    expect(redactArgs([{ Password: "a" }, { ok: 1 }])).toEqual([{ Password: "***" }, { ok: 1 }]);
    expect(redactArgs({ keep: "v", Secret: "s" })).toEqual({ keep: "v", Secret: "***" });
    expect(redactArgs("plain")).toBe("plain");
    expect(redactArgs(null)).toBeNull();
  });
});

describe("旧版 HTTP+SSE 传输(GET /sse + POST /messages)", () => {
  const openSse = async (port: number, token = TOKEN) => {
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: ctl.signal,
    });
    return { res, ctl };
  };
  const readEvents = async (reader: ReadableStreamDefaultReader<Uint8Array>, want: number): Promise<string> => {
    const dec = new TextDecoder();
    let buf = "";
    for (let i = 0; i < 200 && (buf.match(/\n\n/g)?.length ?? 0) < want; i++) {
      const next = await reader.read();
      if (next.done) break;
      buf += dec.decode(next.value);
    }
    return buf;
  };
  const postMsg = async (port: number, sessionId: string, body: unknown, token = TOKEN) => {
    const res = await fetch(`http://127.0.0.1:${port}/messages?sessionId=${sessionId}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    return res.status;
  };

  it("先收到 endpoint 事件,再 POST initialize/tools.list,响应从 SSE 流回来", async () => {
    const h = await boot();
    const { res, ctl } = await openSse(h.port);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await readEvents(reader, 1);
    expect(first).toContain("event: endpoint");
    const sessionId = /sessionId=([0-9a-f]{32})/.exec(first)![1];

    const st1 = await postMsg(h.port, sessionId, {
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "legacy", version: "1" } },
    });
    expect(st1).toBe(202);
    const initEvt = await readEvents(reader, 1);
    expect(initEvt).toContain("event: message");
    expect(initEvt).toContain('"protocolVersion":"2024-11-05"');
    expect(h.clients.at(-1)).toEqual(["legacy 1"]);

    const st2 = await postMsg(h.port, sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(st2).toBe(202);
    const listEvt = await readEvents(reader, 1);
    expect(listEvt).toContain('"tools"');

    /* 通知:202 且不产生响应事件 */
    expect(await postMsg(h.port, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" })).toBe(202);
    ctl.abort();
  });

  it("鉴权与错误路径:401 / 未知 session 404 / 非法 JSON 400", async () => {
    const h = await boot();
    const { res, ctl } = await openSse(h.port);
    const reader = res.body!.getReader();
    const first = await readEvents(reader, 1);
    const sessionId = /sessionId=([0-9a-f]{32})/.exec(first)![1];

    const unauth = await fetch(`http://127.0.0.1:${h.port}/sse`);
    expect(unauth.status).toBe(401);
    expect(await postMsg(h.port, "deadbeef", { jsonrpc: "2.0", id: 1, method: "ping" })).toBe(404);
    expect(await postMsg(h.port, sessionId, { jsonrpc: "2.0", id: 1, method: "ping" }, "wrong")).toBe(401);

    const bad = await fetch(`http://127.0.0.1:${h.port}/messages?sessionId=${sessionId}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: "{oops",
    });
    expect(bad.status).toBe(400);
    const batch = await fetch(`http://127.0.0.1:${h.port}/messages?sessionId=${sessionId}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: "[]",
    });
    expect(batch.status).toBe(400);
    /* 其它方法 */
    expect((await fetch(`http://127.0.0.1:${h.port}/sse`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    ctl.abort();
  });

  it("旧版 SSE 的 keep-alive、缺 sessionId、超大 body", async () => {
    const h = await boot([BASE_TOOL], undefined, 20);
    const { res, ctl } = await openSse(h.port);
    const reader = res.body!.getReader();
    let buf = await readEvents(reader, 1);
    const sessionId = /sessionId=([0-9a-f]{32})/.exec(buf)![1];
    /* 等一个 keep-alive(20ms 间隔) */
    for (let i = 0; i < 40 && !buf.includes("ping"); i++) {
      const next = await reader.read();
      if (next.done) break;
      buf += new TextDecoder().decode(next.value);
    }
    expect(buf).toContain("ping");

    /* 没有 sessionId → 404 */
    const noSession = await fetch(`http://127.0.0.1:${h.port}/messages`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(noSession.status).toBe(404);

    /* 超大 body → 413 */
    const huge = await fetch(`http://127.0.0.1:${h.port}/messages?sessionId=${sessionId}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(1_200_000) }),
    }).catch(() => null);
    if (huge) expect([413, 400]).toContain(huge.status);
    ctl.abort();
  });

  it("工具调用经旧版传输同样可用,并进入活动流", async () => {
    const h = await boot();
    const { res, ctl } = await openSse(h.port);
    const reader = res.body!.getReader();
    const first = await readEvents(reader, 1);
    const sessionId = /sessionId=([0-9a-f]{32})/.exec(first)![1];
    await postMsg(h.port, sessionId, { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "legacy" } } });
    await readEvents(reader, 1);
    expect(await postMsg(h.port, sessionId, {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } },
    })).toBe(202);
    const evt = await readEvents(reader, 1);
    expect(evt).toContain("echo:hi");
    expect(h.activities.some((a) => a.tool === "echo" && a.status === "ok")).toBe(true);
    ctl.abort();
  });
});
