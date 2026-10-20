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
let mkLocal: ReturnType<typeof vi.fn>;
let rmLocal: ReturnType<typeof vi.fn>;
let renLocal: ReturnType<typeof vi.fn>;
let mkRemote: ReturnType<typeof vi.fn>;
let rmRemote: ReturnType<typeof vi.fn>;
let renRemote: ReturnType<typeof vi.fn>;
let uploadRemote: ReturnType<typeof vi.fn>;
let downloadRemote: ReturnType<typeof vi.fn>;
let progressCbs: Array<(p: unknown) => void>;

/**
 * 忠实替身:严格按 preload 里真实暴露的 API 实现(签名/返回值一致)。
 * 每个操作都是可单独编排的 vi.fn,便于断言"界面到底请求了什么"。
 * 见 AGENTS.md §0.1-8(替身必须忠实)。
 */
function fakeBridge(): unknown {
  return {
    local: {
      list: (dir: string) => listLocal(dir),
      mkdir: (dir: string) => mkLocal(dir),
      remove: (t: string) => rmLocal(t),
      rename: (a: string, b: string) => renLocal(a, b),
    },
    sftp: {
      list: (sid: number, dir: string) => listRemote(sid, dir),
      mkdir: (sid: number, dir: string) => mkRemote(sid, dir),
      remove: (sid: number, t: string) => rmRemote(sid, t),
      rename: (sid: number, a: string, b: string) => renRemote(sid, a, b),
      upload: (sid: number, a: string, b: string) => uploadRemote(sid, a, b),
      download: (sid: number, a: string, b: string) => downloadRemote(sid, a, b),
      /** 真实签名返回"取消订阅"函数 */
      onProgress: (cb: (p: unknown) => void) => { progressCbs.push(cb); return () => { progressCbs = progressCbs.filter((x) => x !== cb); }; },
    },
  };
}

async function mountView(
  session: { sid: number; label: string } | null,
  sessions?: Array<{ sid: number; label: string }>,
) {
  vi.resetModules();
  (window as unknown as { sshkit: unknown }).sshkit = fakeBridge();
  const { createSftpView } = await import("../../src/renderer/sftp");
  const { setLocale } = await import("../../src/shared/i18n");
  setLocale("en");
  /* sessions 省略时走 createSftpView 的默认参数(默认无候选会话) */
  const view = sessions
    ? createSftpView(() => session, () => sessions)
    : createSftpView(() => session);
  document.body.append(view.el);
  return view;
}

const pane = (which: "local" | "remote") =>
  document.querySelector(`.sftp-pane[data-which=${which}]`) as HTMLElement;
const rows = (which: "local" | "remote") => pane(which).querySelectorAll(".sp-row").length;
const rowNames = (which: "local" | "remote"): string[] =>
  [...pane(which).querySelectorAll(".sp-row .nm")].map((n) => n.textContent ?? "");
const listedNames = (which: "local" | "remote"): string[] =>
  [...pane(which).querySelectorAll(".sp-row:not(.up) .nm")].map((n) => n.textContent ?? "");
const rowByName = (which: "local" | "remote", name: string): HTMLElement => {
  const row = [...pane(which).querySelectorAll<HTMLElement>(".sp-row")]
    .find((r) => r.querySelector(".nm")?.textContent === name);
  if (!row) throw new Error(`row not found: ${which}/${name}`);
  return row;
};
const click = (el: Element | null): void => { (el as HTMLElement).click(); };
const actionsMenu = (which: "local" | "remote"): HTMLElement => {
  click(pane(which).querySelector('[data-act="actions"]'));
  const menu = document.querySelector(".sp-menu");
  if (!menu) throw new Error("actions menu not opened");
  return menu as HTMLElement;
};
const menuItem = (label: string): HTMLButtonElement => {
  const b = [...document.querySelectorAll<HTMLButtonElement>(".sp-menu-item")].find((x) => x.textContent === label);
  if (!b) throw new Error(`menu item not found: ${label}`);
  return b;
};
const menuLabels = (): string[] => [...document.querySelectorAll(".sp-menu-item")].map((b) => b.textContent ?? "");
const clickRow = (which: "local" | "remote", name: string, init: MouseEventInit = {}): void => {
  rowByName(which, name).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
};
const emitProgress = (p: unknown): void => { for (const cb of progressCbs) cb(p); };
const bannerTexts = (): string[] =>
  [...document.querySelectorAll(".sftp-queue .job .jname")].map((n) => n.textContent ?? "");
const lastBanner = (): string => bannerTexts().at(-1) ?? "";

/* 应用内弹窗契约(产品已把 SFTP 的原生 prompt/confirm 换成 DOM 弹窗 —— Electron 渲染进程
   不支持 window.prompt,原生 confirm 在 Linux 会阻塞渲染进程):
   .prompt-dlg > .dd-box,输入框 .pd-input,确认 .dd-ok,取消 .dd-cancel,关闭 .dd-x。 */
const promptDialog = (): HTMLElement => {
  const dlg = document.querySelector<HTMLElement>(".prompt-dlg");
  if (!dlg) throw new Error("prompt dialog not open");
  return dlg;
};
const openPromptDialog = async (): Promise<HTMLElement> => {
  await vi.waitFor(() => expect(document.querySelector(".prompt-dlg")).toBeTruthy());
  return promptDialog();
};
const answerPrompt = (value: string | null): void => {
  const dlg = promptDialog();
  if (value === null) { click(dlg.querySelector(".dd-cancel")); return; }
  (dlg.querySelector(".pd-input") as HTMLInputElement).value = value;
  click(dlg.querySelector(".dd-ok"));
};
const answerConfirm = (ok: boolean): void => {
  const dlg = promptDialog();
  click(dlg.querySelector(ok ? ".dd-ok" : ".dd-cancel"));
};

const FILE = (name: string, size = 12) => ({
  name, size, isDir: false, mtime: 1_700_000_000, mode: 0o100644,
});
const DIR = (name: string) => ({
  name, size: 0, isDir: true, mtime: 1_700_000_000, mode: 0o040755,
});

beforeEach(() => {
  listLocal = vi.fn(async () => ({ path: "/home/u", entries: [ENTRY("docs", true), ENTRY("a.txt")] }));
  listRemote = vi.fn(async () => ({ path: "/root", entries: [ENTRY("example-pkg-pkg", true)] }));
  mkLocal = vi.fn(async () => undefined);
  rmLocal = vi.fn(async () => undefined);
  renLocal = vi.fn(async () => undefined);
  mkRemote = vi.fn(async () => undefined);
  rmRemote = vi.fn(async () => undefined);
  renRemote = vi.fn(async () => undefined);
  uploadRemote = vi.fn(async () => 1);
  downloadRemote = vi.fn(async () => 2);
  progressCbs = [];
  document.body.innerHTML = "";
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

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

/* ================= 列表渲染与导航 ================= */

describe("SFTP 视图 · 列表渲染", () => {
  it("行内容:文件名 / 权限串 / 大小 / 类型 / 日期(目录大小显示 -)", async () => {
    const view = await mountView({ sid: 1, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rows("local")).toBe(3)); // .. + docs + a.txt
    const localRows = [...pane("local").querySelectorAll<HTMLElement>(".sp-row:not(.up)")];
    expect(localRows[0].querySelector(".nm")!.textContent).toBe("docs");
    expect(localRows[0].querySelector(".pm")!.textContent).toBe("drwxr-xr-x");
    expect(localRows[0].querySelector(".sp-size")!.textContent).toBe("-");
    expect(localRows[0].querySelector(".sp-kind")!.textContent).toBe("folder");
    expect(localRows[1].querySelector(".nm")!.textContent).toBe("a.txt");
    expect(localRows[1].querySelector(".pm")!.textContent).toBe("-rw-r--r--");
    expect(localRows[1].querySelector(".sp-size")!.textContent).toBe("12 B");
    expect(localRows[1].querySelector(".sp-kind")!.textContent).toBe("file");
    expect(localRows[1].querySelector(".sp-date")!.textContent).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2} (AM|PM)$/);
  });

  it("按 dir 变化:首行 .. 点击回上级;根目录不再显示 ..", async () => {
    listLocal.mockImplementation(async (dir: string) => ({ path: dir === "~" ? "/home/me" : dir, entries: [] }));
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rows("local")).toBe(1));
    const up = pane("local").querySelector(".sp-row.up")!;
    expect(up.querySelector(".nm")!.textContent).toBe("..");
    expect(listLocal).toHaveBeenLastCalledWith("~");
    click(up);
    await vi.waitFor(() => expect(listLocal).toHaveBeenLastCalledWith("/home"));
    /* 根目录无 .. 行 */
    listLocal.mockImplementation(async () => ({ path: "/", entries: [] }));
    view.onShow();
    await vi.waitFor(() => expect(pane("local").querySelector(".sp-row.up")).toBeNull());
  });

  it("双击目录进入该目录(joinPath),刷新用远端返回的 path", async () => {
    const view = await mountView({ sid: 1, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    listRemote.mockResolvedValueOnce({ path: "/root/example-pkg-pkg", entries: [] });
    rowByName("remote", "example-pkg-pkg").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await vi.waitFor(() => expect(listRemote).toHaveBeenLastCalledWith(1, "/root/example-pkg-pkg"));
    expect(pane("remote").querySelector(".sp-title")!.textContent).toBe("node-1");
  });

  it("面包屑:‹ 回上级、› 重载、点某个路径段直接跳过去", async () => {
    listRemote.mockImplementation(async (_sid: number, dir: string) => ({
      path: dir === "." ? "/root/a/b" : dir,
      entries: [],
    }));
    const view = await mountView({ sid: 1, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(pane("remote").querySelectorAll(".sp-crumbs .seg").length).toBe(3));
    const segA = [...pane("remote").querySelectorAll<HTMLElement>(".sp-crumbs .seg")]
      .find((s) => s.textContent === "a")!;
    click(segA);
    await vi.waitFor(() => expect(listRemote).toHaveBeenLastCalledWith(1, "/root/a"));
    const arrows = [...pane("remote").querySelectorAll<HTMLElement>(".sp-crumbs .sp-arrow")];
    click(arrows[0]); // ‹
    await vi.waitFor(() => expect(listRemote).toHaveBeenLastCalledWith(1, "/root"));
    const before = listRemote.mock.calls.length;
    click(arrows[1]); // ›
    await vi.waitFor(() => expect(listRemote.mock.calls.length).toBeGreaterThan(before));
    expect(listRemote).toHaveBeenLastCalledWith(1, "/root");
  });

  it("点列头排序:ASC↔DESC,计数指示器只在当前列", async () => {
    listLocal.mockResolvedValue({
      path: "/home/u",
      entries: [FILE("a.txt", 300), FILE("b.txt", 100), FILE("c.txt", 200)],
    });
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local").length).toBe(3));
    const sizeCol = pane("local").querySelector('.sp-col[data-sort="size"]') as HTMLElement;
    click(sizeCol);
    await flushView();
    expect(listedNames("local")).toEqual(["b.txt", "c.txt", "a.txt"]);
    expect(sizeCol.classList.contains("on")).toBe(true);
    expect(sizeCol.dataset.dir).toBe("ASC");
    expect([...pane("local").querySelectorAll(".sp-col.on")]).toEqual([sizeCol]);
    click(sizeCol);
    await flushView();
    expect(listedNames("local")).toEqual(["a.txt", "c.txt", "b.txt"]);
    expect(sizeCol.dataset.dir).toBe("DESC");
  });

  it("筛选:Filter 展开输入、按名称过滤、关闭后清空恢复", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rows("local")).toBe(3));
    const box = pane("local").querySelector(".sp-filter") as HTMLElement;
    expect(box.hidden).toBe(true);
    click(pane("local").querySelector('[data-act="filter"]'));
    expect(box.hidden).toBe(false);
    const input = box.querySelector("input")! as HTMLInputElement;
    input.value = "a.";
    input.dispatchEvent(new Event("input"));
    await flushView();
    expect(rowNames("local")).toEqual(["a.txt"]); // 过滤态下不画 ..
    click(pane("local").querySelector('[data-act="filter"]'));
    await flushView();
    expect(input.value).toBe("");
    expect(rowNames("local")).toContain("docs");
  });

  it("Actions 菜单可显示/隐藏隐藏文件(默认不显示)", async () => {
    listLocal.mockResolvedValue({ path: "/home/u", entries: [FILE(".env"), FILE("a.txt")] });
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    expect(rowNames("local")).not.toContain(".env");
    actionsMenu("local");
    click(menuItem("Show hidden files"));
    await flushView();
    expect(rowNames("local")).toContain(".env");
    actionsMenu("local");
    click(menuItem("Hide hidden files"));
    await flushView();
    expect(rowNames("local")).not.toContain(".env");
  });
});

/* ================= 选择 / 操作菜单 ================= */

async function flushView(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("SFTP 视图 · 选择与操作", () => {
  it("多选:普通点单选、⌘/Ctrl+点切换、Shift+点范围、⌘A 全选、Esc 清除", async () => {
    listLocal.mockResolvedValue({
      path: "/home/u",
      entries: [FILE("a.txt"), FILE("b.txt"), FILE("c.txt")],
    });
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local").length).toBe(3));
    const selected = (): string[] => [...document.querySelectorAll(".sp-row.sel .nm")].map((n) => n.textContent ?? "");

    clickRow("local", "a.txt");
    await flushView();
    expect(selected()).toEqual(["a.txt"]);
    clickRow("local", "b.txt", { ctrlKey: true });
    await flushView();
    expect(selected().sort()).toEqual(["a.txt", "b.txt"]);
    /* Ctrl 点把 anchor 移到 b;Shift 点 c = 选中 b..c 区间 */
    clickRow("local", "c.txt", { shiftKey: true });
    await flushView();
    expect(selected().sort()).toEqual(["b.txt", "c.txt"]);

    pane("local").dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true }));
    await flushView();
    expect(selected().sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    pane("local").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushView();
    expect(selected()).toEqual([]);
  });

  it("Actions → New folder:应用内弹窗输入名称后 mkdir 当前路径并刷新(不依赖原生 prompt)", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rows("local")).toBeGreaterThan(0));

    actionsMenu("local");
    click(menuItem("New folder"));
    const dlg = await openPromptDialog();
    expect(dlg.querySelector(".dd-head span")!.textContent).toBe("New folder");
    expect((dlg.querySelector(".pd-input") as HTMLInputElement).value).toBe("");
    answerPrompt("newdir");
    await vi.waitFor(() => expect(mkLocal).toHaveBeenCalledWith("/home/u/newdir"));
    await vi.waitFor(() => expect(listLocal.mock.calls.length).toBeGreaterThan(1));
    expect(document.querySelector(".prompt-dlg")).toBeNull();

    /* 取消:不动作 */
    actionsMenu("local");
    click(menuItem("New folder"));
    await openPromptDialog();
    answerPrompt(null);
    await flushView();
    expect(mkLocal).toHaveBeenCalledTimes(1);

    /* 空/纯空白输入按 null 处理:不动作 */
    actionsMenu("local");
    click(menuItem("New folder"));
    await openPromptDialog();
    answerPrompt("   ");
    await flushView();
    expect(mkLocal).toHaveBeenCalledTimes(1);

    /* 输入框内回车等价确认 */
    actionsMenu("local");
    click(menuItem("New folder"));
    const dlg2 = await openPromptDialog();
    const input = dlg2.querySelector(".pd-input") as HTMLInputElement;
    input.value = "via-enter";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(mkLocal).toHaveBeenCalledWith("/home/u/via-enter"));

    expect(promptSpy).not.toHaveBeenCalled(); // Electron 里原生 prompt 不可用,不能依赖它
  });

  it("Actions → Rename:弹窗预填旧名,确认后改名;Esc 取消不改", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    clickRow("local", "a.txt");
    await flushView();
    actionsMenu("local");
    click(menuItem("Rename"));
    const dlg = await openPromptDialog();
    expect(dlg.querySelector(".dd-head span")!.textContent).toBe("Rename");
    const input = dlg.querySelector(".pd-input") as HTMLInputElement;
    expect(input.value).toBe("a.txt"); // 预填旧名
    answerPrompt("renamed.txt");
    await vi.waitFor(() => expect(renLocal).toHaveBeenCalledWith("/home/u/a.txt", "/home/u/renamed.txt"));

    /* rename 成功后刷新会清空选中,重新选中再试 Esc 取消 */
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    clickRow("local", "a.txt");
    await flushView();
    actionsMenu("local");
    click(menuItem("Rename"));
    const escDlg = await openPromptDialog();
    const escInput = escDlg.querySelector(".pd-input") as HTMLInputElement;
    escInput.value = "discarded.txt";
    escInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushView();
    expect(document.querySelector(".prompt-dlg")).toBeNull();
    expect(renLocal).toHaveBeenCalledTimes(1);
  });

  it("Actions → Delete:应用内确认弹窗;取消不删、确认才删", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    clickRow("local", "a.txt");
    await flushView();
    actionsMenu("local");
    click(menuItem("Delete"));
    const dlg = await openPromptDialog();
    expect(dlg.querySelector(".pd-input")).toBeNull(); // 确认版没有输入框
    expect(dlg.querySelector(".dd-head span")!.textContent).toBe("Delete item?");
    expect((dlg.querySelector(".dd-ok") as HTMLElement).classList.contains("danger")).toBe(true);
    answerConfirm(false);
    await flushView();
    expect(rmLocal).not.toHaveBeenCalled();

    actionsMenu("local");
    click(menuItem("Delete"));
    await openPromptDialog();
    answerConfirm(true);
    await vi.waitFor(() => expect(rmLocal).toHaveBeenCalledWith("/home/u/a.txt"));
    expect(confirmSpy).not.toHaveBeenCalled(); // 不再用原生 confirm
  });

  it("多选态菜单:Delete N items 逐条执行并汇总提示;批量上传按选中项逐个走", async () => {
    listLocal.mockResolvedValue({ path: "/home/u", entries: [FILE("a.txt"), FILE("b.txt"), FILE("c.txt")] });
    const view = await mountView({ sid: 3, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local").length).toBe(3));
    clickRow("local", "a.txt");
    clickRow("local", "b.txt", { ctrlKey: true });
    await flushView();
    const menu = actionsMenu("local");
    expect([...menu.querySelectorAll(".sp-menu-item")].map((b) => b.textContent)).toContain("Delete 2 items");
    expect(menuLabels()).toContain("Upload 2 items →");
    click(menuItem("Delete 2 items"));
    await vi.waitFor(() => expect(rmLocal).toHaveBeenCalledTimes(2));
    expect(lastBanner()).toBe("Deleted 2/2 items");
    await vi.waitFor(() => expect(listLocal.mock.calls.length).toBeGreaterThan(1));
  });

  it("单个文件 Upload → / ← Download 调桥的真实参数,并刷新目标栏", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [FILE("x.bin", 100)] });
    const view = await mountView({ sid: 7, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local").length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(listedNames("remote")).toContain("x.bin"));

    clickRow("local", "a.txt");
    await flushView();
    actionsMenu("local");
    click(menuItem("Upload →"));
    await vi.waitFor(() => expect(uploadRemote).toHaveBeenCalledWith(7, "/home/u/a.txt", "/root/a.txt"));
    await vi.waitFor(() => expect(listRemote.mock.calls.length).toBeGreaterThan(1));

    clickRow("remote", "x.bin");
    await flushView();
    actionsMenu("remote");
    click(menuItem("← Download"));
    await vi.waitFor(() => expect(downloadRemote).toHaveBeenCalledWith(7, "/root/x.bin", "/home/u/x.bin"));
  });

  it("选中目录/无选中时传输给提示,不发桥调用", async () => {
    const view = await mountView({ sid: 7, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("docs"));
    clickRow("local", "docs");
    await flushView();
    actionsMenu("local");
    click(menuItem("Upload →"));
    await flushView();
    expect(uploadRemote).not.toHaveBeenCalled();
    expect(lastBanner()).toBe("Select a file first (folder transfer is not supported yet)");
  });

  it("传输失败:横幅显示主进程原因(去掉 invoke 前缀)", async () => {
    uploadRemote.mockRejectedValueOnce(new Error("Error invoking remote method 'sftp:upload', disk full"));
    const view = await mountView({ sid: 7, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    clickRow("local", "a.txt");
    await flushView();
    actionsMenu("local");
    click(menuItem("Upload →"));
    await vi.waitFor(() => expect(lastBanner()).toBe("disk full"));
  });

  it("远端未绑定会话时,远端 Actions 给出原因且不发桥调用", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-empty")).toBeTruthy());
    actionsMenu("remote");
    click(menuItem("New folder"));
    await flushView();
    expect(mkRemote).not.toHaveBeenCalled();
    expect(lastBanner()).toBe("Remote pane is not bound to a session");
  });

  it("空态 Select host:没有可用会话时提示;有会话时列出来并可绑定后拉远端", async () => {
    const noSession = await mountView(null);
    noSession.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-empty .sp-select")).toBeTruthy());
    click(document.querySelector(".sftp-empty .sp-select"));
    await flushView();
    expect(lastBanner()).toBe("No session available yet — connect a host from the host list first");
    expect(document.querySelector(".sp-menu")).toBeNull();

    document.body.innerHTML = ""; // 同一用例内重挂:先清掉上一个视图
    const view = await mountView(null, [{ sid: 42, label: "node-9" }]);
    listRemote.mockResolvedValueOnce({ path: "/srv", entries: [FILE("z.txt")] });
    view.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-empty .sp-select")).toBeTruthy());
    click(document.querySelector(".sftp-empty .sp-select"));
    await vi.waitFor(() => expect(!!document.querySelector(".sp-menu")).toBe(true));
    expect(document.querySelector(".sp-menu-title")!.textContent).toBe("Select the session to bind");
    click(menuItem("node-9"));
    await vi.waitFor(() => expect(listRemote).toHaveBeenCalledWith(42, "."));
    await vi.waitFor(() => expect(rowNames("remote")).toContain("z.txt"));
    expect(pane("remote").querySelector(".sp-title")!.textContent).toBe("node-9");
    expect(document.querySelector(".sftp-empty")).toBeNull();
  });

  it("拖拽到对面栏即传输:左 → 右是上传,并刷新两栏", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [] });
    const view = await mountView({ sid: 5, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    const src = rowByName("local", "a.txt");
    src.dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    const body = pane("remote").querySelector(".sp-body")!;
    body.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true }));
    body.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(uploadRemote).toHaveBeenCalledWith(5, "/home/u/a.txt", "/root/a.txt"));
    await vi.waitFor(() => expect(listRemote.mock.calls.length).toBeGreaterThan(1));
  });
});

/* ================= 错误态 / 进度 / 刷新语义 ================= */

describe("SFTP 视图 · 刷新与进度", () => {
  it("onShow 同时刷新两栏:本地用 ~,远端用当前 sid 与 .", async () => {
    const view = await mountView({ sid: 11, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(listLocal).toHaveBeenCalledWith("~"));
    await vi.waitFor(() => expect(listRemote).toHaveBeenCalledWith(11, "."));
  });

  it("没有会话时不请求远端,只刷本地", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(listLocal).toHaveBeenCalled());
    await flushView();
    expect(listRemote).not.toHaveBeenCalled();
  });

  it("本地列表失败:横幅显示原因,远端仍正常渲染(不互相拖垮)", async () => {
    listLocal.mockRejectedValueOnce(new Error("Error invoking remote method 'local:list', EACCES"));
    const view = await mountView({ sid: 1, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(lastBanner()).toBe("EACCES"));
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
  });

  it("传输进度:新任务显示名称与百分比,done 4s 后自动移除,error 展示原因", async () => {
    const view = await mountView(null);
    view.onShow();
    await flushView();
    vi.useFakeTimers();
    try {
      emitProgress({ sid: 1, jobId: 1, dir: "up", file: "a.txt", bytes: 512, total: 1024, state: "active" });
      const job = document.querySelector(".sftp-queue .job")!;
      expect(job.querySelector(".jname")!.textContent).toBe("⬆ a.txt");
      expect((job.querySelector(".jfill") as HTMLElement).style.width).toBe("50%");
      expect(job.querySelector(".jstat")!.textContent).toBe("512 B / 1.0 KB");

      emitProgress({ sid: 1, jobId: 2, dir: "down", file: "b.bin", bytes: 0, total: 0, state: "error", error: "broken pipe" });
      const err = document.querySelector(".sftp-queue .job")!;
      expect(err.className).toBe("job err");
      expect(err.querySelector(".jstat")!.textContent).toBe("broken pipe");
      expect(err.querySelector(".jname")!.textContent).toBe("⬇ b.bin");

      emitProgress({ sid: 1, jobId: 3, dir: "up", file: "c.txt", bytes: 2048, total: 2048, state: "done" });
      const done = document.querySelector(".sftp-queue .job")!;
      expect(done.className).toBe("job done");
      expect(done.querySelector(".jstat")!.textContent).toBe("2.0 KB done");
      expect(done.isConnected).toBe(true);
      await vi.advanceTimersByTimeAsync(4100);
      expect(done.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("进度队列最多保留 8 条(最旧的被淘汰),同 job 的后续事件更新同一行", async () => {
    const view = await mountView(null);
    view.onShow();
    await flushView();
    for (let i = 1; i <= 10; i++) {
      emitProgress({ sid: 1, jobId: i, dir: "up", file: `f${i}.txt`, bytes: 1, total: 4, state: "active" });
    }
    await flushView();
    const names = [...document.querySelectorAll(".sftp-queue .job .jname")].map((n) => n.textContent);
    expect(names.length).toBe(8);
    expect(names[0]).toBe("⬆ f10.txt"); // 新的在最前
    expect(names).not.toContain("⬆ f1.txt");
    expect(names).not.toContain("⬆ f2.txt");
    emitProgress({ sid: 1, jobId: 10, dir: "up", file: "f10.txt", bytes: 4, total: 4, state: "active" });
    await flushView();
    expect(document.querySelectorAll(".sftp-queue .job").length).toBe(8);
    expect(document.querySelector(".sftp-queue .job .jfill")!.getAttribute("style")).toContain("100%");
  });
});

/* ================= 格式化 / 路径语义 ================= */

/** 构造某个"本地时间 h 点"的 unix 秒,用于断言 12 小时制日期格式 */
const atLocal = (h: number, m = 0): number =>
  Math.floor(new Date(2026, 7, 14, h, m, 0, 0).getTime() / 1000);

describe("SFTP 视图 · 格式化与路径", () => {
  it("日期:0 显示 -,零点/中午显示 12:xx AM/PM,下午显示 PM", async () => {
    listLocal.mockResolvedValue({
      path: "/home/u",
      entries: [
        { ...FILE("zero.txt"), mtime: 0 }, // 0 → "-"
        { ...FILE("midnight.txt"), mtime: atLocal(0) },
        { ...FILE("noon.txt"), mtime: atLocal(12) },
        { ...FILE("pm.txt"), mtime: atLocal(13, 5) },
      ],
    });
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("pm.txt"));
    const dateOf = (name: string): string =>
      rowByName("local", name).querySelector(".sp-date")!.textContent ?? "";
    expect(dateOf("zero.txt")).toBe("-");
    expect(dateOf("midnight.txt")).toBe("8/14/2026, 12:00 AM");
    expect(dateOf("noon.txt")).toBe("8/14/2026, 12:00 PM");
    expect(dateOf("pm.txt")).toBe("8/14/2026, 1:05 PM");
  });

  it("大小:B / KB / MB / GB / TB 换算,小于 10 保留一位小数", async () => {
    listLocal.mockResolvedValue({
      path: "/home/u",
      entries: [
        FILE("b.txt", 1023),
        FILE("kb.txt", 1024),
        FILE("kb15.txt", 1536),
        FILE("kb10.txt", 10 * 1024),
        FILE("mb.txt", 1024 * 1024),
        FILE("gb.txt", 5 * 1024 * 1024 * 1024),
        FILE("tb.txt", 3 * 1024 * 1024 * 1024 * 1024),
      ],
    });
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("tb.txt"));
    const sizeOf = (name: string): string =>
      rowByName("local", name).querySelector(".sp-size")!.textContent ?? "";
    expect(sizeOf("b.txt")).toBe("1023 B");
    expect(sizeOf("kb.txt")).toBe("1.0 KB");
    expect(sizeOf("kb15.txt")).toBe("1.5 KB");
    expect(sizeOf("kb10.txt")).toBe("10 KB");
    expect(sizeOf("mb.txt")).toBe("1.0 MB");
    expect(sizeOf("gb.txt")).toBe("5.0 GB");
    expect(sizeOf("tb.txt")).toBe("3.0 TB");
  });

  it("joinPath:本地 ~ 前缀与远端 / 根路径都能正确拼接(双击进入)", async () => {
    listLocal.mockResolvedValue({ path: "~", entries: [DIR("dir1")] });
    const view = await mountView({ sid: 1, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("dir1"));
    rowByName("local", "dir1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await vi.waitFor(() => expect(listLocal).toHaveBeenLastCalledWith("~/dir1"));

    listRemote.mockResolvedValue({ path: "/", entries: [DIR("etc")] });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("remote")).toContain("etc"));
    rowByName("remote", "etc").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await vi.waitFor(() => expect(listRemote).toHaveBeenLastCalledWith(1, "/etc"));
  });

  it("parentOf:远端 . 与 .. 反复向上不会越界", async () => {
    listRemote.mockResolvedValue({ path: ".", entries: [] });
    const view = await mountView({ sid: 2, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBe(1));
    const up = (): HTMLElement => pane("remote").querySelector<HTMLElement>(".sp-row.up")!;
    click(up());
    await vi.waitFor(() => expect(listRemote).toHaveBeenLastCalledWith(2, ".."));
    click(up());
    await vi.waitFor(() => expect(listRemote).toHaveBeenLastCalledWith(2, ".."));
    expect(listRemote.mock.calls.filter((c) => c[1] === "..").length).toBeGreaterThanOrEqual(2);
  });

  it("双击文件不导航(只有目录才进入)", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    const before = listLocal.mock.calls.length;
    rowByName("local", "a.txt").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await flushView();
    expect(listLocal.mock.calls.length).toBe(before);
  });

  it("排序:日期列与类型列也可切换方向", async () => {
    listLocal.mockResolvedValue({
      path: "/home/u",
      entries: [
        { ...FILE("old.txt"), mtime: 100 },
        { ...FILE("new.txt"), mtime: 200 },
        { ...FILE("dir"), isDir: true, mtime: 50 },
      ],
    });
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local").length).toBe(3));
    const dateCol = pane("local").querySelector('.sp-col[data-sort="date"]') as HTMLElement;
    click(dateCol);
    await flushView();
    expect(dateCol.classList.contains("on")).toBe(true);
    expect(dateCol.dataset.dir).toBe("ASC");
    expect(listedNames("local")[0]).toBe("dir"); // 目录永远优先
    expect(listedNames("local").slice(1)).toEqual(["old.txt", "new.txt"]);
    click(dateCol);
    await flushView();
    expect(dateCol.dataset.dir).toBe("DESC");
    const kindCol = pane("local").querySelector('.sp-col[data-sort="kind"]') as HTMLElement;
    click(kindCol);
    await flushView();
    expect(kindCol.dataset.dir).toBe("ASC");
    expect(dateCol.classList.contains("on")).toBe(false);
  });
});

/* ================= 拖拽 / 远端操作 ================= */

describe("SFTP 视图 · 拖拽与远端操作", () => {
  it("同栏内拖拽不触发传输;dragend 清掉 dragging/drop-hot 状态", async () => {
    const view = await mountView({ sid: 5, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    const src = rowByName("local", "a.txt");
    src.dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    expect(src.classList.contains("dragging")).toBe(true);
    const body = pane("local").querySelector(".sp-body")!;
    body.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true }));
    expect(body.classList.contains("drop-hot")).toBe(false);
    body.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true }));
    await flushView();
    expect(uploadRemote).not.toHaveBeenCalled();
    src.dispatchEvent(new MouseEvent("dragend", { bubbles: true }));
    expect(src.classList.contains("dragging")).toBe(false);
    expect(document.querySelectorAll(".sp-body.drop-hot").length).toBe(0);
  });

  it("跨栏拖放的放置热点在 dragover 时高亮,drop 后消失", async () => {
    const view = await mountView({ sid: 5, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    rowByName("local", "a.txt").dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    const body = pane("remote").querySelector(".sp-body")!;
    body.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true }));
    expect(body.classList.contains("drop-hot")).toBe(true);
    body.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(body.classList.contains("drop-hot")).toBe(false));
    await vi.waitFor(() => expect(uploadRemote).toHaveBeenCalled());
  });

  it("远端多选下载:菜单出现 Download 2 items,逐条走 download", async () => {
    listRemote.mockResolvedValue({
      path: "/root",
      entries: [FILE("x.bin", 10), FILE("y.bin", 20)],
    });
    const view = await mountView({ sid: 9, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote").length).toBe(2));
    clickRow("remote", "x.bin");
    clickRow("remote", "y.bin", { ctrlKey: true });
    await flushView();
    actionsMenu("remote");
    expect(menuLabels()).toContain("← Download 2 items");
    click(menuItem("← Download 2 items"));
    await vi.waitFor(() => expect(downloadRemote).toHaveBeenCalledTimes(2));
    expect(downloadRemote).toHaveBeenNthCalledWith(1, 9, "/root/x.bin", "/home/u/x.bin");
    expect(downloadRemote).toHaveBeenNthCalledWith(2, 9, "/root/y.bin", "/home/u/y.bin");
  });

  it("远端 Actions:New folder / Rename / Delete 都带 sid 走远端桥(应用内弹窗)", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const confirmSpy = vi.spyOn(window, "confirm");
    listRemote.mockResolvedValue({ path: "/root", entries: [FILE("x.bin")] });
    const view = await mountView({ sid: 7, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote")).toContain("x.bin"));

    actionsMenu("remote");
    click(menuItem("New folder"));
    await openPromptDialog();
    answerPrompt("dir2");
    await vi.waitFor(() => expect(mkRemote).toHaveBeenCalledWith(7, "/root/dir2"));

    clickRow("remote", "x.bin");
    await flushView();
    actionsMenu("remote");
    click(menuItem("Rename"));
    const dlg = await openPromptDialog();
    expect((dlg.querySelector(".pd-input") as HTMLInputElement).value).toBe("x.bin");
    answerPrompt("renamed.bin");
    await vi.waitFor(() => expect(renRemote).toHaveBeenCalledWith(7, "/root/x.bin", "/root/renamed.bin"));

    /* rename 成功后刷新会清空选中,重新选中再删除 */
    await vi.waitFor(() => expect(listedNames("remote")).toContain("x.bin"));
    clickRow("remote", "x.bin");
    await flushView();
    actionsMenu("remote");
    click(menuItem("Delete"));
    await openPromptDialog();
    answerConfirm(true);
    await vi.waitFor(() => expect(rmRemote).toHaveBeenCalledWith(7, "/root/x.bin"));
    expect(promptSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("远端新建目录失败:横幅显示原因(去掉 invoke 前缀)", async () => {
    mkRemote.mockRejectedValueOnce(new Error("Error invoking remote method 'sftp:mkdir', permission denied"));
    const view = await mountView({ sid: 7, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    actionsMenu("remote");
    click(menuItem("New folder"));
    await openPromptDialog();
    answerPrompt("dir3");
    await vi.waitFor(() => expect(lastBanner()).toBe("permission denied"));
  });

  /* 回归:i18n 约定要求英文界面不出现中文(AGENTS §5)。
     曾被硬编码成 "先在左/右栏选中一项";修复后走 tr("sftp.selectItemFirst")。 */
  it("英文界面下,远端未选中条目时的提示不能是中文", async () => {
    const view = await mountView({ sid: 7, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote")).toContain("example-pkg-pkg"));
    actionsMenu("remote");
    click(menuItem("Rename"));
    await flushView();
    const text = lastBanner();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    expect(text).toBe("Select an item in the pane first");
  });

  it("Actions → Go up:回上级目录并刷新", async () => {
    listRemote.mockResolvedValue({ path: "/root/a", entries: [] });
    const view = await mountView({ sid: 1, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBe(1));
    actionsMenu("remote");
    click(menuItem("Go up"));
    await vi.waitFor(() => expect(listRemote).toHaveBeenLastCalledWith(1, "/root"));
  });

  it("远端多选删除:Delete 2 items 逐条带 sid 走 sftp.remove", async () => {
    listRemote.mockResolvedValue({
      path: "/root",
      entries: [FILE("x.bin", 10), FILE("y.bin", 20)],
    });
    const view = await mountView({ sid: 9, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote").length).toBe(2));
    clickRow("remote", "x.bin");
    clickRow("remote", "y.bin", { ctrlKey: true });
    await flushView();
    actionsMenu("remote");
    expect(menuLabels()).toContain("Delete 2 items");
    click(menuItem("Delete 2 items"));
    await vi.waitFor(() => expect(rmRemote).toHaveBeenCalledTimes(2));
    expect(rmRemote).toHaveBeenNthCalledWith(1, 9, "/root/x.bin");
    expect(rmRemote).toHaveBeenNthCalledWith(2, 9, "/root/y.bin");
    expect(lastBanner()).toBe("Deleted 2/2 items");
  });
});
