// @vitest-environment jsdom
/* MCP 分区的渲染:状态卡、活动流、可展开详情。
   bridge 是假实现 —— 渲染层模块在 import 时读取 window.sshkit,
   所以每个用例都先装桥再 vi.resetModules() 动态 import(与 sftp-view 同一套路)。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBridge, type BridgeCalls } from "../helpers/renderer";
import type { McpActivity, McpStatus } from "../../src/shared/mcp";

type McpMod = typeof import("../../src/renderer/mcp");
type I18nMod = typeof import("../../src/shared/i18n");

let calls: BridgeCalls;
let mcp: McpMod;
let i18n: I18nMod;

async function boot(overrides: Record<string, (...args: unknown[]) => unknown> = {}): Promise<void> {
  vi.resetModules();
  ({ calls } = installBridge(overrides));
  mcp = await import("../../src/renderer/mcp");
  i18n = await import("../../src/shared/i18n");
  i18n.setLocale("en");
}

const status = (patch: Partial<McpStatus> = {}): McpStatus => ({
  running: false, port: 7788, token: "tok", clients: [], error: null, activity: [], policy: "full", ...patch,
});

const act = (patch: Partial<McpActivity> = {}): McpActivity => ({
  id: 1, at: new Date(2026, 0, 2, 3, 4, 5).getTime(), client: "Claude Code 2.0",
  method: "tools/call", tool: "sftp_list", status: "ok", ms: 12,
  args: '{"host":"prod","path":"/var/www"}', result: '{"count":2}', ...patch,
});

const text = (el: Element | null): string => el?.textContent ?? "";

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => { vi.restoreAllMocks(); });

describe("MCP 活动行", () => {
  beforeEach(async () => { await boot(); });

  it("标题:协议方法直接显示方法名;工具调用带上 host/path(或 dir)提示", () => {
    expect(mcp.activityTitle(act({ method: "initialize", tool: "-", args: undefined }))).toBe("initialize");
    expect(mcp.activityTitle(act())).toBe("sftp_list  prod /var/www");
    expect(mcp.activityTitle(act({ args: '{"host":"prod","dir":"/tmp"}' }))).toBe("sftp_list  prod /tmp");
    expect(mcp.activityTitle(act({ args: '{"host":"prod"}', tool: "sftp_stat" }))).toBe("sftp_stat  prod");
    expect(mcp.activityTitle(act({ args: "not-json", tool: "ping" }))).toBe("ping");
    expect(mcp.activityTitle(act({ args: '{"host":42,"path":null}', tool: "t" }))).toBe("t");
  });

  it("状态/耗时/可展开详情;没有可展开内容就不渲染 <pre>", () => {
    const row = mcp.activityRow(act({ status: "running", ms: undefined }));
    expect(row.className).toContain("running");
    expect(text(row)).toContain(i18n.tr("mcp.stRunning"));
    const detail = row.querySelector(".mcp-act-detail") as HTMLElement;
    expect(detail.hidden).toBe(true);
    (row.querySelector(".mcp-act-head") as HTMLElement).click();
    expect(detail.hidden).toBe(false);
    expect(text(detail)).toContain(i18n.tr("mcp.arguments"));

    const err = mcp.activityRow(act({ status: "error", args: undefined, result: undefined, error: "boom" }));
    expect(text(err)).toContain("boom");
    expect(text(err)).toContain(i18n.tr("mcp.stError"));

    const cancelled = mcp.activityRow(act({ status: "cancelled", args: undefined, result: undefined }));
    expect(text(cancelled)).toContain(i18n.tr("mcp.stCancelled"));

    const bare = mcp.activityRow(act({ args: undefined, result: undefined }));
    expect(bare.querySelector(".mcp-act-detail")).toBeNull();
  });
});

describe("MCP 状态卡", () => {
  it("客户端配置包含 URL 与 Bearer token", async () => {
    await boot();
    const cfg = JSON.parse(mcp.clientConfig(status({ port: 9999, token: "abc" }))) as {
      mcpServers: { sshkit: { type: string; url: string; headers: { Authorization: string } } };
    };
    expect(cfg.mcpServers.sshkit).toMatchObject({
      type: "http", url: "http://127.0.0.1:9999/mcp", headers: { Authorization: "Bearer abc" },
    });
  });

  it("运行中:显示地址/客户端/错误,按钮各司其职", async () => {
    await boot({
      "mcp.set": async () => status({ running: false }),
      "mcp.regenerateToken": async () => status({ running: true, token: "new" }),
    });
    const box = document.createElement("div");
    document.body.append(box);
    mcp.paintMcp(box, status({ running: true, clients: ["Claude Code 2.0", "Codex"], error: "端口被占" }));
    expect(text(box)).toContain("http://127.0.0.1:7788/mcp");
    expect(text(box)).toContain("Claude Code 2.0 · Codex");
    expect(text(box)).toContain("端口被占");
    expect(mcp.currentMcpStatus()).toMatchObject({ running: true });

    const btns = [...box.querySelectorAll("button")].map((b) => b.textContent);
    expect(btns).toEqual([
      i18n.tr("mcp.disable"), i18n.tr("mcp.copyConfig"), i18n.tr("mcp.regenerate"), i18n.tr("mcp.stop"),
    ]);

    (box.querySelectorAll("button")[1] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(String(calls["clipboard.write"].at(-1)![0])).toContain("Bearer tok");

    (box.querySelectorAll("button")[0] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls["mcp.set"].at(-1)![0]).toEqual({ enabled: false });
    expect(text(box)).toContain(i18n.tr("mcp.enable"));

    (box.querySelectorAll("button")[2] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls["mcp.regenerateToken"].length).toBe(1);
    expect(text(box)).toContain("http://127.0.0.1:7788/mcp");
  });

  it("权限档:徽章跟随;下拉切换会调用 mcp:set", async () => {
    await boot({ "mcp.set": async () => status({ running: true, policy: "read-only" }) });
    const box = document.createElement("div");
    document.body.append(box);
    mcp.paintMcp(box, status({ running: true, policy: "full" }));
    expect(text(box.querySelector(".mcp-mode"))).toContain(i18n.tr("mcp.policyFull"));
    expect(mcp.policyLabel("standard")).toBe(i18n.tr("mcp.policyStandard"));
    expect(mcp.policyLabel("read-only")).toBe(i18n.tr("mcp.policyReadOnly"));

    const sel = box.querySelector(".mcp-policy") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["read-only", "standard", "full"]);
    expect(sel.value).toBe("full");
    sel.value = "read-only";
    sel.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls["mcp.set"].at(-1)![0]).toEqual({ policy: "read-only" });
    expect(text(box.querySelector(".mcp-mode"))).toContain(i18n.tr("mcp.policyReadOnly"));

    /* STOP 按钮:调用中断 */
    (box.querySelectorAll("button")[3] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls["mcp.abort"].length).toBe(1);
  });

  it("标准档批准弹层:允许/拒绝都会回传", async () => {
    await boot();
    mcp.showApproval({ id: "a1", tool: "sftp_write_file", args: '{"host":"prod"}' });
    let box = document.querySelector(".mcp-approve") as HTMLElement;
    expect(text(box)).toContain("sftp_write_file");
    (box.querySelector('[data-act="allow"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls["mcp.answerApproval"].at(-1)).toEqual(["a1", true]);
    expect(document.querySelector(".mcp-approve")).toBeNull();

    mcp.showApproval({ id: "a2", tool: "ssh_exec", args: "{}" });
    box = document.querySelector(".mcp-approve") as HTMLElement;
    (box.querySelector('[data-act="deny"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls["mcp.answerApproval"].at(-1)).toEqual(["a2", false]);
  });

  it("未启用:提示怎么开,并且没有已连接提示", async () => {
    await boot();
    const box = document.createElement("div");
    document.body.append(box);
    mcp.paintMcp(box, status());
    expect(text(box)).toContain(i18n.tr("mcp.stopped"));
    expect(text(box)).toContain(i18n.tr("mcp.offHint"));
    expect(text(box)).toContain(i18n.tr("mcp.noClient"));
    expect([...box.querySelectorAll("button")].map((b) => b.textContent)[0]).toBe(i18n.tr("mcp.enable"));
  });
});

describe("MCP 分区挂载", () => {
  it("无活动时显示空态;收到事件后插到最前面;状态更新会重画", async () => {
    let pushActivity: ((ev: McpActivity) => void) | null = null;
    let pushStatus: ((s: McpStatus) => void) | null = null;
    await boot({
      "mcp.status": async () => status({ running: true, activity: [] }),
      "mcp.onActivity": (cb) => { pushActivity = cb as (ev: McpActivity) => void; return () => undefined; },
      "mcp.onStatus": (cb) => { pushStatus = cb as (s: McpStatus) => void; return () => undefined; },
    });
    const box = document.createElement("div");
    document.body.append(box);
    mcp.mountMcpSection(box);
    await new Promise((r) => setTimeout(r, 0));
    expect(text(box.querySelector(".mcp-empty"))).toBe(i18n.tr("mcp.noActivity"));

    pushActivity!(act({ id: 2, tool: "sftp_stat" }));
    expect(box.querySelector(".mcp-empty")).toBeNull();
    expect(box.querySelectorAll(".mcp-act").length).toBe(1);
    pushActivity!(act({ id: 3, tool: "list_hosts" }));
    const titles = [...box.querySelectorAll(".mcp-act-title")].map((e) => e.textContent);
    expect(titles.length).toBe(2);
    expect(text(box.querySelectorAll(".mcp-act-title")[0])).toContain("list_hosts");

    /* 同一 id 的"最终状态"覆盖原来那行(不再出现两条) */
    const before = box.querySelectorAll(".mcp-act").length;
    pushActivity!(act({ id: 3, status: "running", result: undefined }));
    expect(box.querySelectorAll(".mcp-act").length).toBe(before);
    pushActivity!(act({ id: 3, status: "error", result: undefined, error: "boom" }));
    expect(box.querySelectorAll(".mcp-act").length).toBe(before);
    expect(text(box.querySelector(".mcp-act"))).toContain("boom");

    pushStatus!(status({ running: true, clients: ["Codex"] }));
    expect(text(box)).toContain("Codex");
  });

  it("初始状态里已有历史活动:直接渲染", async () => {
    await boot({
      "mcp.status": async () => status({ running: true, activity: [act({ id: 1, tool: "a" }), act({ id: 2, tool: "b" })] }),
    });
    const box = document.createElement("div");
    document.body.append(box);
    mcp.mountMcpSection(box);
    await new Promise((r) => setTimeout(r, 0));
    expect(box.querySelectorAll(".mcp-act").length).toBe(2);
  });
});
