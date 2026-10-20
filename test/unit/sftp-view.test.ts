// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SFTP 双栏视图的行为测试(jsdom + 假 bridge)。
 * 这里锁住本轮修过的两个 bug:
 *   1) renderEmpty 曾用 innerHTML 换掉 .sp-rows 容器 → 之后所有渲染都写进"游离节点",
 *      面板永远停在 "Connect to host";
 *   2) 列表失败曾被渲染成"未连接"空态,而不是带原因的 error 态。
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void };
const defer = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const ENTRY = (name: string, isDir = false) => ({
  name, size: isDir ? 0 : 12, isDir, mtime: 1_700_000_000, mode: isDir ? 0o040755 : 0o100644,
});

let listLocal: ReturnType<typeof vi.fn>;
let listRemote: ReturnType<typeof vi.fn>;
let progressCbs: Array<(p: unknown) => void>;

/**
 * 忠实替身:严格按 preload 里真实暴露的 API 实现(签名/返回值一致)。
 * 视图会调用而本用例**故意不提供**的能力(例如真实传输)显式抛错,
 * 而不是返回一个"看起来合理"的值把问题盖住 —— 见 AGENTS.md 铁律 8。
 */
const notStubbed = (name: string) => (): never => { throw new Error(`not stubbed in test: ${name}`); };

function fakeBridge(): unknown {
  return {
    local: {
      list: (dir: string) => listLocal(dir),
      mkdir: async (dir: string) => { throw new Error(`not stubbed in test: local.mkdir(${dir})`); },
      remove: async (t: string) => { throw new Error(`not stubbed in test: local.remove(${t})`); },
      rename: async (a: string, b: string) => { throw new Error(`not stubbed in test: local.rename(${a},${b})`); },
    },
    sftp: {
      list: (sid: number, dir: string) => listRemote(sid, dir),
      mkdir: notStubbed("sftp.mkdir"),
      remove: notStubbed("sftp.remove"),
      rename: notStubbed("sftp.rename"),
      upload: notStubbed("sftp.upload"),
      download: notStubbed("sftp.download"),
      /** 真实签名返回"取消订阅"函数 */
      onProgress: (cb: (p: unknown) => void) => { progressCbs.push(cb); return () => { progressCbs = progressCbs.filter((x) => x !== cb); }; },
    },
  };
}

async function mountView(session: { sid: number; label: string } | null) {
  vi.resetModules();
  (window as unknown as { sshkit: unknown }).sshkit = fakeBridge();
  const { createSftpView } = await import("../../src/renderer/sftp");
  const { setLocale } = await import("../../src/shared/i18n");
  setLocale("en");
  const view = createSftpView(() => session, () => (session ? [session] : []));
  document.body.append(view.el);
  return view;
}

const pane = (which: "local" | "remote") =>
  document.querySelector(`.sftp-pane[data-which=${which}]`) as HTMLElement;
const rows = (which: "local" | "remote") => pane(which).querySelectorAll(".sp-row").length;

beforeEach(() => {
  listLocal = vi.fn(async () => ({ path: "/home/u", entries: [ENTRY("docs", true), ENTRY("a.txt")] }));
  listRemote = vi.fn(async () => ({ path: "/root", entries: [ENTRY("example-pkg-pkg", true)] }));
  progressCbs = [];
  document.body.innerHTML = "";
});
afterEach(() => { document.body.innerHTML = ""; });

describe("SFTP 视图 · 无会话", () => {
  it("显示 Connect to host 空态,并隐藏列头", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-empty")).toBeTruthy());
    expect(document.querySelector(".sftp-empty h3")!.textContent).toBe("Connect to host");
    expect((pane("remote").querySelector(".sp-cols") as HTMLElement).style.display).toBe("none");
  });
});

describe("SFTP 视图 · 有会话", () => {
  it("列出远端条目,列头恢复显示", async () => {
    const view = await mountView({ sid: 1, label: "node-1 (192.0.2.10)" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    expect(pane("remote").querySelector(".sp-title")!.textContent).toBe("node-1 (192.0.2.10)");
    expect((pane("remote").querySelector(".sp-cols") as HTMLElement).style.display).not.toBe("none");
    expect(document.querySelector(".sftp-empty")).toBeNull();
  });

  it("从空态切到有会话后,列表能画出来(回归:容器被 innerHTML 换掉导致永久空态)", async () => {
    let session: { sid: number; label: string } | null = null;
    vi.resetModules();
    (window as unknown as { sshkit: unknown }).sshkit = fakeBridge();
    const { createSftpView } = await import("../../src/renderer/sftp");
    const view = createSftpView(() => session, () => (session ? [session] : []));
    document.body.append(view.el);

    view.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-empty")).toBeTruthy());

    session = { sid: 7, label: "node-1" };
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    expect(document.querySelector(".sftp-empty")).toBeNull();
  });

  it("列表失败显示错误态(带原因 + Retry),而不是伪装成未连接", async () => {
    listRemote.mockRejectedValueOnce(new Error("(SSH) Channel open failure: open failed"));
    const view = await mountView({ sid: 1, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-err")).toBeTruthy());
    expect(document.querySelector(".sftp-err h3")!.textContent).toBe("SFTP unavailable");
    expect(pane("remote").querySelector(".sftp-err p")!.textContent).toContain("Channel open failure");
    /* 错误态与"未连接"空态共用 .sftp-empty 这个**布局类**(另有 .sftp-err 语义标记),
       所以这里断言的是"不再有未连接空态",用 :not(.sftp-err) 精确表达。 */
    expect(pane("remote").querySelector(".sftp-empty:not(.sftp-err)")).toBeNull();
  });

  it("错误态点 Retry 会重新拉一次,成功后回到列表", async () => {
    listRemote.mockRejectedValueOnce(new Error("boom"));
    const view = await mountView({ sid: 1, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-err")).toBeTruthy());

    const before = listRemote.mock.calls.length;
    (document.querySelector(".sp-retry") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    expect(listRemote.mock.calls.length).toBeGreaterThan(before);
    expect(document.querySelector(".sftp-err")).toBeNull();
  });

  it("relabel() 切换语言后表头/列名跟着变", async () => {
    const view = await mountView({ sid: 1, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    expect(pane("local").querySelector(".sp-title")!.textContent).toBe("Local");

    const { setLocale } = await import("../../src/shared/i18n");
    setLocale("zh");
    view.relabel();
    await vi.waitFor(() => expect(pane("local").querySelector(".sp-title")!.textContent).toBe("本地"));
    expect([...pane("remote").querySelectorAll(".sp-col")].map((b) => b.textContent)).toEqual(
      ["名称", "修改日期", "大小", "类型"],
    );
  });
});
