// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, installBridge, loadRendererDom, type BridgeCalls } from "../helpers/renderer";
import type { HostKeyAsk, KnownHostRow } from "../../src/shared/knownhost";

/**
 * knownhosts.ts 的行为测试:已知主机列表(空态/行/删除/导入/多选)+ 主机密钥询问弹窗。
 *
 * 弹窗文案逐字取自原版(F18):未知主机 "Are you sure you want to connect?",
 * 指纹变更 "The fingerprint for <host> has changed" + error 色。
 *
 * 说明:共享 helper 的假桥目前**没有** knownhost.onAsk/onAskCancel(installHostKeyDialog
 * 需要它们),本文件按 preload 真实签名在实例上补齐,不改共享 helper。
 */

type AnyBridge = Record<string, any>;

let rows: KnownHostRow[];
let importImpl: () => Promise<{ canceled?: boolean; added: number; skipped: number }>;
let removeImpl: (host: string) => Promise<KnownHostRow[]>;
let calls: BridgeCalls;

let askCb: ((req: HostKeyAsk) => void) | null;
let askCancelCb: ((reqId: string) => void) | null;

const ROW = (over: Partial<KnownHostRow> = {}): KnownHostRow => ({
  host: "node-a.example.com",
  keyType: "ssh-ed25519",
  fingerprint: "SHA256:AAAABBBBCCCC",
  hashed: false,
  ...over,
});

async function waitFor(cond: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (cond()) return;
    await flush(2);
  }
  throw new Error(`waitFor timeout: ${label}`);
}

/** 装 DOM + 忠实假桥(含 helper 缺少的两个订阅方法),再动态 import 被测模块 */
function installFake(overrides: Record<string, (...a: unknown[]) => unknown> = {}): AnyBridge {
  loadRendererDom();
  const b = installBridge({
    "knownhost.list": async () => rows.map((r) => ({ ...r })),
    "knownhost.remove": async (host) => removeImpl(String(host)),
    "knownhost.import": async () => importImpl(),
    ...overrides,
  });
  calls = b.calls;
  const api = (window as unknown as { sshkit: AnyBridge }).sshkit;
  /* preload 真实签名:onAsk/onAskCancel 返回"取消订阅"函数 */
  api.knownhost.onAsk = (cb: (req: HostKeyAsk) => void) => {
    askCb = cb;
    return () => { askCb = null; };
  };
  api.knownhost.onAskCancel = (cb: (reqId: string) => void) => {
    askCancelCb = cb;
    return () => { askCancelCb = null; };
  };
  return api;
}

async function mountView(): Promise<HTMLElement> {
  installFake();
  const { createKnownHostsView } = await import("../../src/renderer/knownhosts");
  const view = createKnownHostsView();
  document.body.append(view.el);
  view.onShow();
  await waitFor(() => !!view.el.querySelector(".kh-empty, .kh-list"));
  return view.el;
}

async function mountDialog(): Promise<void> {
  installFake();
  const { installHostKeyDialog } = await import("../../src/renderer/knownhosts");
  installHostKeyDialog();
  await waitFor(() => askCb !== null, "onAsk subscribed");
}

const rowEls = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".kh-row")];
const rowByHost = (host: string): HTMLElement => {
  const el = rowEls().find((r) => r.querySelector(".kh-host")!.textContent === host);
  if (!el) throw new Error(`row not found: ${host}`);
  return el;
};
const selCount = (): string | null => document.querySelector(".kh-selcount")?.textContent ?? null;
const selectedHosts = (): string[] =>
  rowEls().filter((r) => r.classList.contains("sel")).map((r) => r.querySelector(".kh-host")!.textContent!);
const clickRow = (host: string, mods: MouseEventInit = {}): void => {
  rowByHost(host).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...mods }));
};
const lastToast = (): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>(".toast")].at(-1) ?? null;
const backdrop = (): HTMLElement | null => document.querySelector(".hk-backdrop");
const ask = (over: Partial<HostKeyAsk> = {}): void => {
  if (!askCb) throw new Error("onAsk not installed");
  askCb({ reqId: "req-1", host: "node-a.example.com", status: "unknown", keyType: "ssh-ed25519", fingerprint: "SHA256:AAAABBBBCCCC", ...over });
};
const buttonTexts = (root: ParentNode = document): string[] =>
  [...root.querySelectorAll("button")].map((b) => b.textContent ?? "");

beforeEach(() => {
  rows = [];
  importImpl = async () => ({ canceled: false, added: 0, skipped: 0 });
  removeImpl = async (host) => {
    rows = rows.filter((r) => r.host !== host);
    return rows;
  };
  askCb = null;
  askCancelCb = null;
  document.body.innerHTML = "";
  document.documentElement.lang = "en";
  localStorage.clear();
  vi.resetModules();
});

describe("已知主机列表", () => {
  it("空列表显示引导空态(而不是一张空表)", async () => {
    const el = await mountView();
    expect(el.querySelector(".kh-empty h3")!.textContent).toBe("Known hosts will appear here");
    expect(el.querySelector(".kh-empty p")!.textContent).toBe(
      "Known hosts are trusted server identities saved for secure future connections.",
    );
    expect(el.querySelector(".kh-list")).toBeNull();
    expect(calls["knownhost.list"]).toHaveLength(1);
  });

  it("按连接显示 主机 / 指纹 / 密钥类型;哈希化条目的删除按钮禁用并说明原因", async () => {
    rows = [ROW({ host: "alpha.example.com" }), ROW({ host: "10.0.0.9", fingerprint: "SHA256:HASHED", hashed: true })];
    const el = await mountView();

    expect(rowEls()).toHaveLength(2);
    const normal = rowByHost("alpha.example.com");
    expect(normal.querySelector(".kh-fp")!.textContent).toBe("SHA256:AAAABBBBCCCC");
    expect(normal.querySelector(".kh-type")!.textContent).toBe("ssh-ed25519");
    const normalDel = normal.querySelector(".kh-del") as HTMLButtonElement;
    expect(normalDel.disabled).toBe(false);

    const hashed = rowByHost("10.0.0.9");
    const hashedDel = hashed.querySelector(".kh-del") as HTMLButtonElement;
    expect(hashedDel.disabled).toBe(true);
    expect(hashedDel.title).toBe("哈希化条目无法按主机名删除");
  });

  it("点行内 ✕ 删除该主机并刷新列表", async () => {
    rows = [ROW({ host: "alpha.example.com" }), ROW({ host: "beta.example.com" })];
    await mountView();
    const before = calls["knownhost.list"]!.length;

    (rowByHost("alpha.example.com").querySelector(".kh-del") as HTMLButtonElement).click();
    await waitFor(() => rowEls().length === 1, "row removed");

    expect(calls["knownhost.remove"]!.at(-1)).toEqual(["alpha.example.com"]);
    expect(calls["knownhost.list"]!.length).toBeGreaterThan(before);
    expect(rowEls()[0].querySelector(".kh-host")!.textContent).toBe("beta.example.com");
  });

});

describe("导入 known_hosts", () => {
  it("导入成功:报告新增/跳过数量,并刷新出新增条目", async () => {
    const el = await mountView();
    importImpl = async () => {
      rows = [...rows, ROW({ host: "imported.example.com" })];
      return { canceled: false, added: 2, skipped: 1 };
    };
    (el.querySelector(".kh-import") as HTMLButtonElement).click();
    await waitFor(() => !!lastToast(), "toast");

    expect(lastToast()!.textContent).toBe("Imported 2 known hosts, skipped 1");
    await waitFor(() => rowEls().length === 1, "imported row");
    expect(rowByHost("imported.example.com")).toBeTruthy();
  });

  it("只新增 1 条时用单数文案", async () => {
    const el = await mountView();
    importImpl = async () => ({ canceled: false, added: 1, skipped: 0 });
    (el.querySelector(".kh-import") as HTMLButtonElement).click();
    await waitFor(() => !!lastToast());
    expect(lastToast()!.textContent).toBe("Imported 1 known host");
  });

  it("没有可导入的新条目时明确说明跳过了多少", async () => {
    const el = await mountView();
    importImpl = async () => ({ canceled: false, added: 0, skipped: 3 });
    (el.querySelector(".kh-import") as HTMLButtonElement).click();
    await waitFor(() => !!lastToast());
    expect(lastToast()!.textContent).toBe("Nothing new to import (3 skipped)");
  });

  it("导入失败:非 Error 的拒绝值(字符串)也能显示,不是 undefined", async () => {
    const el = await mountView();
    importImpl = async () => { throw "filesystem is read-only"; };
    (el.querySelector(".kh-import") as HTMLButtonElement).click();
    await waitFor(() => !!lastToast());
    expect(lastToast()!.textContent).toBe("Import failed: filesystem is read-only");
  });

  it("用户取消文件选择时:不弹提示、不刷新列表(没有变化就不要制造变化)", async () => {
    const el = await mountView();
    const before = calls["knownhost.list"]!.length;
    importImpl = async () => ({ canceled: true, added: 0, skipped: 0 });
    (el.querySelector(".kh-import") as HTMLButtonElement).click();
    await flush(8);
    expect(lastToast()).toBeNull();
    expect(calls["knownhost.list"]!.length).toBe(before);
  });

  it("导入失败显示原因(失败路径必须响)", async () => {
    const el = await mountView();
    importImpl = async () => { throw new Error("EACCES: permission denied"); };
    (el.querySelector(".kh-import") as HTMLButtonElement).click();
    await waitFor(() => !!lastToast());
    expect(lastToast()!.textContent).toBe("Import failed: EACCES: permission denied");
    expect(rowEls()).toHaveLength(0);
  });
});

describe("多选", () => {
  it("普通点是单选并显示选中计数;再点另一行仍是单选", async () => {
    rows = [ROW({ host: "a.example.com" }), ROW({ host: "b.example.com" })];
    await mountView();

    clickRow("a.example.com");
    await waitFor(() => selCount() === "1 selected");
    expect(selectedHosts()).toEqual(["a.example.com"]);

    clickRow("b.example.com");
    await waitFor(() => selectedHosts().includes("b.example.com"));
    expect(selCount()).toBe("1 selected");
    expect(selectedHosts()).toEqual(["b.example.com"]);
  });

  it("Cmd/Ctrl+点切换单条选中,再点一次取消", async () => {
    rows = [ROW({ host: "a.example.com" }), ROW({ host: "b.example.com" })];
    await mountView();

    clickRow("a.example.com");
    await waitFor(() => selCount() === "1 selected");
    clickRow("b.example.com", { ctrlKey: true });
    await waitFor(() => selCount() === "2 selected");
    expect(selectedHosts().sort()).toEqual(["a.example.com", "b.example.com"]);

    clickRow("b.example.com", { metaKey: true });
    await waitFor(() => selCount() === "1 selected");
    expect(selectedHosts()).toEqual(["a.example.com"]);
  });

  it("Shift+点按锚点做范围选择", async () => {
    rows = [ROW({ host: "a.example.com" }), ROW({ host: "b.example.com" }), ROW({ host: "c.example.com" })];
    await mountView();

    clickRow("a.example.com");
    await waitFor(() => selCount() === "1 selected");
    clickRow("c.example.com", { shiftKey: true });
    await waitFor(() => selCount() === "3 selected");
    expect(selectedHosts().sort()).toEqual(["a.example.com", "b.example.com", "c.example.com"]);
  });

  it("锚点行被外部删除后 Shift+点:不崩溃、不清空已有选择(防御分支)", async () => {
    /* 场景:选中 a 后列表被外部刷新,锚点 a 不再存在于 DOM;此时 Shift+点 c。
       期望:范围选择条件不成立时不改选择,也不抛错。 */
    rows = [ROW({ host: "a.example.com" }), ROW({ host: "b.example.com" }), ROW({ host: "c.example.com" })];
    await mountView();
    clickRow("a.example.com");
    await waitFor(() => selCount() === "1 selected");

    rows = [ROW({ host: "b.example.com" }), ROW({ host: "c.example.com" })];
    (document.querySelector(".kh-sel-all") as HTMLButtonElement).click(); // 触发一次刷新,锚点仍是 a
    await waitFor(() => selCount() === "3 selected");
    clickRow("c.example.com", { shiftKey: true });
    await flush(6);
    expect(selectedHosts().sort()).toEqual(["b.example.com", "c.example.com"]);
    expect(selCount()).toBe("3 selected");
  });

  it("哈希化条目不参与多选(无法按主机名定位)", async () => {
    rows = [ROW({ host: "hashed-row", hashed: true }), ROW({ host: "b.example.com" })];
    await mountView();

    clickRow("hashed-row");
    await flush(6);
    expect(selCount()).toBeNull();
    expect(selectedHosts()).toEqual([]);
  });

  it("Select All 只选非哈希化条目,Delete 逐个删除并报告 成功/总数", async () => {
    rows = [
      ROW({ host: "a.example.com" }),
      ROW({ host: "b.example.com" }),
      ROW({ host: "hashed-row", hashed: true }),
    ];
    await mountView();

    clickRow("a.example.com");
    await waitFor(() => selCount() === "1 selected");
    (document.querySelector(".kh-sel-all") as HTMLButtonElement).click();
    await waitFor(() => selCount() === "2 selected");
    expect(selectedHosts().sort()).toEqual(["a.example.com", "b.example.com"]);

    (document.querySelector(".kh-sel-del") as HTMLButtonElement).click();
    await waitFor(() => !!lastToast() && rowEls().length === 1, "bulk delete");
    expect(lastToast()!.textContent).toBe("Removed 2/2");
    expect(calls["knownhost.remove"]!.length).toBe(2);
    expect(rowEls()[0].querySelector(".kh-host")!.textContent).toBe("hashed-row");
  });

  it("批量删除单个失败不打断其余项,报告真实成功数", async () => {
    rows = [ROW({ host: "a.example.com" }), ROW({ host: "b.example.com" })];
    removeImpl = async (host) => {
      if (host === "a.example.com") throw new Error("nope");
      rows = rows.filter((r) => r.host !== host);
      return rows;
    };
    await mountView();

    clickRow("a.example.com");
    await waitFor(() => selCount() === "1 selected");
    (document.querySelector(".kh-sel-all") as HTMLButtonElement).click();
    await waitFor(() => selCount() === "2 selected");
    (document.querySelector(".kh-sel-del") as HTMLButtonElement).click();
    await waitFor(() => !!lastToast() && lastToast()!.textContent === "Removed 1/2");
    expect(rowEls()).toHaveLength(1);
  });

  it("Clear selection 与 Esc 都能清空选择并收起选择条", async () => {
    rows = [ROW({ host: "a.example.com" }), ROW({ host: "b.example.com" })];
    const el = await mountView();

    clickRow("a.example.com");
    await waitFor(() => selCount() === "1 selected");
    (document.querySelector(".kh-sel-clear") as HTMLButtonElement).click();
    await waitFor(() => selCount() === null);
    expect(selectedHosts()).toEqual([]);

    clickRow("b.example.com");
    await waitFor(() => selCount() === "1 selected");
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => selCount() === null);
    expect(selectedHosts()).toEqual([]);
  });
});

describe("主机密钥询问弹窗", () => {
  it("未知主机:标题/正文/指纹/三个按钮与原版一致", async () => {
    await mountDialog();
    ask();

    const back = backdrop()!;
    expect(back).toBeTruthy();
    expect(back.dataset.req).toBe("req-1");
    const title = back.querySelector("h3")!;
    expect(title.textContent).toBe("Are you sure you want to connect?");
    expect(title.className).toBe("primary");

    const text = back.querySelector(".hk-body")!.textContent!;
    expect(text).toContain("The authenticity of node-a.example.com can not be established.");
    expect(text).toContain("ssh-ed25519 fingerprint is SHA256:");
    expect(back.querySelector(".hk-fp")!.textContent).toBe("SHA256:AAAABBBBCCCC");
    expect(text).toContain("Do you want to add it to the list of known hosts?");
    expect(buttonTexts(back)).toEqual(["Close", "Continue", "Add and continue"]);
    expect(back.querySelectorAll(".hk-actions .btn.primary")).toHaveLength(1);
  });

  it("未知主机的三个按钮分别回传 cancel / continue / add", async () => {
    await mountDialog();

    ask({ reqId: "r-close" });
    (backdrop()!.querySelectorAll("button")[0] as HTMLButtonElement).click();
    expect(calls["knownhost.answer"]!.at(-1)).toEqual(["r-close", "cancel"]);
    expect(backdrop()).toBeNull();

    ask({ reqId: "r-continue" });
    (backdrop()!.querySelectorAll("button")[1] as HTMLButtonElement).click();
    expect(calls["knownhost.answer"]!.at(-1)).toEqual(["r-continue", "continue"]);
    expect(backdrop()).toBeNull();

    ask({ reqId: "r-add" });
    (backdrop()!.querySelectorAll("button")[2] as HTMLButtonElement).click();
    expect(calls["knownhost.answer"]!.at(-1)).toEqual(["r-add", "add"]);
    expect(backdrop()).toBeNull();
  });

  it("指纹变更:标题走 error 色,正文说明风险,按钮 Replace / Add as new / Cancel", async () => {
    await mountDialog();
    ask({ reqId: "r-changed", status: "changed", keyType: "rsa-sha2-512", fingerprint: "SHA256:NEWFP" });
    const back = backdrop()!;

    const title = back.querySelector("h3")!;
    expect(title.textContent).toBe("The fingerprint for node-a.example.com has changed");
    expect(title.className).toBe("error");
    const text = back.querySelector(".hk-body")!.textContent!;
    expect(text).toContain("This could indicate a potential security breach.");
    expect(text).toContain("New rsa-sha2-512 fingerprint is SHA256:");
    expect(back.querySelector(".hk-fp")!.textContent).toBe("SHA256:NEWFP");
    expect(buttonTexts(back)).toEqual(["Replace", "Add as new", "Cancel"]);

    (backdrop()!.querySelectorAll("button")[0] as HTMLButtonElement).click();
    expect(calls["knownhost.answer"]!.at(-1)).toEqual(["r-changed", "replace"]);
    expect(backdrop()).toBeNull();

    ask({ reqId: "r-changed-2", status: "changed" });
    (backdrop()!.querySelectorAll("button")[2] as HTMLButtonElement).click();
    expect(calls["knownhost.answer"]!.at(-1)).toEqual(["r-changed-2", "cancel"]);
  });

  it("回归:新的询问替换旧询问(否则那次连接永远卡在握手)", async () => {
    await mountDialog();
    ask({ reqId: "req-old", host: "old.example.com" });
    expect(backdrop()!.dataset.req).toBe("req-old");

    ask({ reqId: "req-new", host: "new.example.com" });
    expect(document.querySelectorAll(".hk-backdrop")).toHaveLength(1);
    expect(backdrop()!.dataset.req).toBe("req-new");
    expect(backdrop()!.querySelector("h3")!.textContent).toBe("Are you sure you want to connect?");
  });

  it("会话结束的取消事件只撤掉对应 reqId 的弹窗", async () => {
    await mountDialog();
    ask({ reqId: "req-1" });
    expect(askCancelCb).toBeTruthy();

    askCancelCb!("req-other");
    expect(backdrop()).toBeTruthy();
    askCancelCb!("req-1");
    expect(backdrop()).toBeNull();
  });

  it("没有选择时按 Esc 不触发无意义刷新", async () => {
    rows = [ROW({ host: "a.example.com" })];
    const el = await mountView();
    const before = calls["knownhost.list"]!.length;

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush(4);
    expect(calls["knownhost.list"]!.length).toBe(before);
    expect(selCount()).toBeNull();
  });

  it("主机名/指纹里的 HTML 不被当成标记执行(只当文本)", async () => {
    await mountDialog();
    ask({
      status: "changed",
      host: `<img src=x onerror="globalThis.__pwned=1">`,
      keyType: `<script>`,
      fingerprint: `<b>SHA256:FP</b>`,
    });
    const back = backdrop()!;
    expect(back.querySelector("img")).toBeNull();
    expect(back.querySelector("script")).toBeNull();
    expect(back.querySelector("b")).toBeNull();
    expect(back.querySelector("h3")!.textContent).toContain("<img src=x");
    expect(back.querySelector(".hk-body")!.textContent).toContain("<b>SHA256:FP</b>");
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });
});
