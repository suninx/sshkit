// @vitest-environment jsdom
/* 多主机命令面板:勾主机 → 执行 → 结果并排;串行/并行;中断。
   桥是假实现,只验证界面请求了什么、画出了什么。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBridge, type BridgeCalls } from "../helpers/renderer";
import type { HostRecord } from "../../src/shared/host";

type Mod = typeof import("../../src/renderer/multiexec");
let me: Mod;
let calls: BridgeCalls;
let i18n: typeof import("../../src/shared/i18n");

const HOST = (id: string, name: string): HostRecord => ({
  id, name, host: `10.0.0.${id.slice(-1)}`, port: 22, username: "root", authType: "agent", createdAt: "",
});

async function boot(overrides: Record<string, (...a: unknown[]) => unknown> = {}): Promise<void> {
  vi.resetModules();
  ({ calls } = installBridge(overrides));
  me = await import("../../src/renderer/multiexec");
  i18n = await import("../../src/shared/i18n");
  i18n.setLocale("en");
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".me-row")];
const rowText = (): string[] => rows().map((r) => r.textContent ?? "");

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => { me?.closeMultiExec(); vi.restoreAllMocks(); });

describe("结果摘要", () => {
  it("统计成功/失败/在跑", async () => {
    await boot();
    const base = { hostId: "h", hostName: "h", exitCode: 0, stdout: "", stderr: "", ms: 1, truncated: false };
    expect(me.summarizeRows([
      { ...base, state: "done", exitCode: 0 },
      { ...base, state: "done", exitCode: 2 },
      { ...base, state: "error", exitCode: -1 },
      { ...base, state: "running" },
    ])).toEqual({ total: 4, ok: 1, failed: 2, running: 1 });
    expect(me.summarizeRows([])).toEqual({ total: 0, ok: 0, failed: 0, running: 0 });
  });
});

describe("面板", () => {
  it("勾选主机、执行:并行模式,结果按主机渲染并显示摘要", async () => {
    await boot({
      "multiexec.run": async (ids: string[]) => ids.map((id) => ({
        hostId: id, hostName: id, exitCode: id === "h_1" ? 0 : 3, stdout: `out-${id}`, stderr: "", ms: 12, truncated: false,
      })),
    });
    me.openMultiExec([HOST("h_1", "web-1"), HOST("h_2", "web-2")]);
    expect(document.querySelectorAll(".me-host input").length).toBe(2);
    (document.querySelector(".me-cmd") as HTMLTextAreaElement).value = "df -h /";
    (document.querySelector('[data-act="run"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const call = calls["multiexec.run"].at(-1)!;
    expect(call[0]).toEqual(["h_1", "h_2"]);
    expect(call[1]).toBe("df -h /");
    expect(call[2]).toEqual({ mode: "parallel" });
    expect(rows().length).toBe(2);
    expect(rowText().join("|")).toContain("exit 0");
    expect(rowText().join("|")).toContain("exit 3");
    expect(document.querySelector(".me-summary")!.textContent).toContain("2");

    /* 点行展开输出 */
    const out = rows()[0].querySelector(".me-out") as HTMLElement;
    expect(out.hidden).toBe(true);
    (rows()[0].querySelector(".me-row-head") as HTMLElement).click();
    expect(out.hidden).toBe(false);
    expect(out.textContent).toContain("out-h_1");
  });

  it("串行模式与取消按钮;空命令/无勾选不执行", async () => {
    await boot({ "multiexec.cancel": async () => 2 });
    me.openMultiExec([HOST("h_1", "web-1")]);
    const runBtn = document.querySelector('[data-act="run"]') as HTMLElement;
    /* 空命令 */
    runBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls["multiexec.run"]).toBeUndefined();
    /* 有命令但没勾主机 */
    (document.querySelector(".me-cmd") as HTMLTextAreaElement).value = "uptime";
    (document.querySelector(".me-host input") as HTMLInputElement).checked = false;
    runBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls["multiexec.run"]).toBeUndefined();
    /* 勾回来 + 串行 */
    (document.querySelector(".me-host input") as HTMLInputElement).checked = true;
    (document.querySelector('input[value="serial"]') as HTMLInputElement).checked = true;
    runBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect((calls["multiexec.run"].at(-1) as unknown[])[2]).toEqual({ mode: "serial" });
    (document.querySelector('[data-act="cancel"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls["multiexec.cancel"].length).toBe(1);
  });

  it("实时结果事件会更新行(同一主机 running → done);关闭后取消订阅", async () => {
    let push: ((ev: unknown) => void) | null = null;
    let offCalls = 0;
    await boot({
      "multiexec.onResult": (cb: unknown) => { push = cb as (ev: unknown) => void; return () => { offCalls += 1; }; },
    });
    me.openMultiExec([HOST("h_1", "web-1")]);
    (document.querySelector(".me-cmd") as HTMLTextAreaElement).value = "id";
    (document.querySelector('[data-act="run"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    push!({ hostId: "h_1", hostName: "web-1", state: "running", exitCode: 0, stdout: "", stderr: "", ms: 0, truncated: false });
    expect(rows()[0].textContent).toContain(i18n.tr("me.running"));
    push!({ hostId: "h_1", hostName: "web-1", state: "done", exitCode: 0, stdout: "uid=0", stderr: "", ms: 5, truncated: false });
    expect(rows()[0].textContent).toContain("exit 0");
    /* 同一行的重复终态事件不再重绘(避免闪烁) */
    push!({ hostId: "h_1", hostName: "web-1", state: "done", exitCode: 0, stdout: "uid=0", stderr: "", ms: 5, truncated: false });
    expect((rows()[0].querySelector(".me-out") as HTMLElement).textContent).toContain("uid=0");
    me.closeMultiExec();
    expect(offCalls).toBe(1);
    expect(me.isMultiExecOpen()).toBe(false);
  });

  it("没有主机时给提示;关闭按钮移除面板", async () => {
    await boot();
    me.openMultiExec([]);
    expect(document.querySelector(".me-empty")).toBeTruthy();
    expect(me.isMultiExecOpen()).toBe(true);
    (document.querySelector('[data-act="close"]') as HTMLElement).click();
    expect(me.isMultiExecOpen()).toBe(false);
    expect(document.querySelector(".me-overlay")).toBeNull();
  });
});
