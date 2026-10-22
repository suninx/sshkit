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
let startDrag: ReturnType<typeof vi.fn>;
let pathForFile: ReturnType<typeof vi.fn>;
let transferPolicies: string[];
let progressCbs: Array<(p: unknown) => void>;
let cancelJob: ReturnType<typeof vi.fn>;
let chmodRemote: ReturnType<typeof vi.fn>;
let chmodLocal: ReturnType<typeof vi.fn>;

/**
 * 忠实替身:严格按 preload 里真实暴露的 API 实现(签名/返回值一致)。
 * 每个操作都是可单独编排的 vi.fn,便于断言"界面到底请求了什么"。
 * 见 AGENTS.md §0.1-8(替身必须忠实)。
 */
function fakeBridge(): unknown {
  return {
    native: { pathForFile: (f: File) => pathForFile(f) },
    local: {
      list: (dir: string) => listLocal(dir),
      mkdir: (dir: string) => mkLocal(dir),
      remove: (t: string) => rmLocal(t),
      rename: (a: string, b: string) => renLocal(a, b),
      chmod: (target: string, mode: number) => chmodLocal(target, mode),
    },
    sftp: {
      list: (sid: number, dir: string) => listRemote(sid, dir),
      mkdir: (sid: number, dir: string) => mkRemote(sid, dir),
      remove: (sid: number, t: string) => rmRemote(sid, t),
      rename: (sid: number, a: string, b: string) => renRemote(sid, a, b),
      /* 视图现在统一走引擎接口 transfer(dir, ...),内部按方向落到原来的两个 spy 上,
         这样既有断言(检查真实参数)继续有效,同时能记录 policy */
      transfer: (sid: number, dir: "up" | "down", a: string, b: string, policy?: string) => {
        transferPolicies.push(policy ?? "");
        return dir === "up" ? uploadRemote(sid, a, b) : downloadRemote(sid, a, b);
      },
      cancel: (jobId: number) => cancelJob(jobId),
      chmod: (sid: number, target: string, mode: number) => chmodRemote(sid, target, mode),
      startDrag: (filePath: string) => startDrag(filePath),
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
  /* 返回真实的 TreeResult 形状(视图会读 skippedFiles/skippedEntries) */
  const treeOk = { jobId: 1, files: 1, skippedFiles: 0, skippedEntries: 0, bytes: 0, cancelled: false };
  uploadRemote = vi.fn(async () => ({ ...treeOk }));
  downloadRemote = vi.fn(async () => ({ ...treeOk }));
  transferPolicies = [];
  cancelJob = vi.fn(async () => true);
  chmodRemote = vi.fn(async () => undefined);
  chmodLocal = vi.fn(async () => undefined);
  startDrag = vi.fn();
  pathForFile = vi.fn(() => "/tmp/dropped.bin");
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

  it("没选中任何项时传输只给提示,不发桥调用", async () => {
    const view = await mountView({ sid: 7, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    actionsMenu("local");
    click(menuItem("Upload →"));
    await flushView();
    expect(uploadRemote).not.toHaveBeenCalled();
    expect(lastBanner()).toBe("Select a file or folder first");
  });

  it("选中目录也能传:递归交给主进程引擎", async () => {
    const view = await mountView({ sid: 7, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("docs"));
    clickRow("local", "docs");
    await flushView();
    actionsMenu("local");
    click(menuItem("Upload →"));
    await vi.waitFor(() => expect(uploadRemote).toHaveBeenCalledWith(7, "/home/u/docs", "/root/docs"));
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

/* ================= 覆盖率补强:边界路径 / 弹窗关闭 / 排序与拖拽方向 ================= */

describe("SFTP 视图 · 边界路径", () => {
  it("重连后的迟到错误直接删掉旧询问框(不叠两个弹窗)", async () => {
    /* 由已知主机询问弹窗覆盖;这里只确认 SFTP 侧没有残留 .prompt-dlg 干扰 —— 留作占位以防回归。 */
    const view = await mountView(null);
    view.onShow();
    await flushView();
    expect(document.querySelector(".prompt-dlg")).toBeNull();
  });

  it("远端列表失败且主进程给的是字符串:横幅与错误态显示原始原因", async () => {
    listRemote.mockRejectedValueOnce("plain channel failure");
    const view = await mountView({ sid: 1, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-err")).toBeTruthy());
    expect(lastBanner()).toBe("plain channel failure");
    expect(document.querySelector(".sftp-err p")!.textContent).toBe("plain channel failure");
  });

  it("空态/错误态/列表渲染时 `.sp-cols` 不在 DOM 也不会崩(列头是可选装饰)", async () => {
    const view = await mountView(null);
    view.onShow();
    /* 无会话:只有远端的 renderEmpty 会画空态;本地栏走普通 render */
    await vi.waitFor(() => expect(document.querySelectorAll(".sftp-empty").length).toBe(1));
    /* 人为移走列头:renderEmpty(远端)与 render(本地)都要能继续工作 */
    for (const cols of document.querySelectorAll(".sftp-pane .sp-cols")) cols.remove();
    view.onShow();
    await vi.waitFor(() => expect(document.querySelectorAll(".sftp-empty").length).toBe(1));

    const filterInput = pane("local").querySelector(".sp-filter input") as HTMLInputElement;
    filterInput.value = "zzz";
    filterInput.dispatchEvent(new Event("input"));
    await flushView();
    /* 过滤后没有条目,但列表容器仍然可用(说明 render 没有因缺列头提前崩掉) */
    expect(pane("local").querySelector(".sp-rows")).toBeTruthy();

    document.body.innerHTML = "";
    listRemote.mockRejectedValueOnce(new Error("boom"));
    const errView = await mountView({ sid: 2, label: "node-2" });
    errView.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-err")).toBeTruthy());
    document.querySelectorAll('.sftp-pane[data-which="remote"] .sp-cols').forEach((n) => n.remove());
    listRemote.mockRejectedValueOnce(new Error("boom2"));
    errView.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-err p")!.textContent).toContain("boom2"));
  });

  it("parentOf:Home 之上仍停在 ~;根目录下一级回到 /", async () => {
    /* 本地栏当前目录就是 "~",Go up 应仍请求 "~"(不能越出 home) */
    listLocal.mockResolvedValue({ path: "~", entries: [] });
    const view = await mountView({ sid: 1, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(listLocal).toHaveBeenCalledWith("~"));
    const before = listLocal.mock.calls.length;
    actionsMenu("local");
    click(menuItem("Go up"));
    await vi.waitFor(() => expect(listLocal.mock.calls.length).toBeGreaterThan(before));
    expect(listLocal).toHaveBeenLastCalledWith("~");

    /* 远端在 /root,Go up 应回到 "/" */
    document.body.innerHTML = "";
    listRemote.mockResolvedValue({ path: "/root", entries: [] });
    const v2 = await mountView({ sid: 3, label: "node-3" });
    v2.onShow();
    await vi.waitFor(() => expect(listRemote).toHaveBeenCalledWith(3, "."));
    actionsMenu("remote");
    click(menuItem("Go up"));
    await vi.waitFor(() => expect(listRemote).toHaveBeenLastCalledWith(3, "/"));
  });

  it("排序:名称列可点三次(ASC→DESC→ASC);日期/大小/类型列覆盖目录与缺失字段", async () => {
    listLocal.mockResolvedValue({
      path: "/home/u",
      entries: [
        { ...FILE("b.txt"), mtime: 200 },
        { ...FILE("a.txt"), mtime: 100 },
        DIR("dir"),
        DIR("dir2"),
        { ...FILE("nodate.txt"), mtime: undefined },
        { ...FILE("nodate2.txt"), mtime: undefined },
      ],
    });
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local").length).toBe(6));

    const col = (k: string): HTMLElement => pane("local").querySelector(`.sp-col[data-sort="${k}"]`) as HTMLElement;
    const nameCol = col("name");
    click(nameCol);
    await flushView();
    expect(listedNames("local")).toEqual(["dir", "dir2", "a.txt", "b.txt", "nodate.txt", "nodate2.txt"]);
    click(nameCol);
    await flushView();
    expect(nameCol.dataset.dir).toBe("DESC");
    expect(listedNames("local").slice(0, 2).sort()).toEqual(["dir", "dir2"]); // 目录永远优先(DESC 只反转同类型内部)
    click(nameCol);
    await flushView();
    expect(nameCol.dataset.dir).toBe("ASC");

    click(col("date"));
    await flushView();
    expect(listedNames("local")[0]).toBe("dir"); // 目录优先,其余按 mtime(缺失按 0)
    click(col("date"));
    await flushView();
    expect(col("date").dataset.dir).toBe("DESC");

    click(col("size"));
    await flushView();
    expect(listedNames("local")[0]).toBe("dir");
    click(col("size"));
    await flushView();
    expect(col("size").dataset.dir).toBe("DESC");

    click(col("kind"));
    await flushView();
    expect(col("kind").dataset.dir).toBe("ASC");
  });

  it("条目没有 mode 时权限串按 0 渲染(不显示 undefined)", async () => {
    listLocal.mockResolvedValue({
      path: "/home/u",
      entries: [{ name: "weird.bin", size: 3, isDir: false, mtime: 0 }],
    });
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("weird.bin"));
    expect(rowByName("local", "weird.bin").querySelector(".pm")!.textContent).toBe("----------");
  });

  it("dragstart 后直接 dragend(未 drop):清掉目标栏的 drop-hot 高亮", async () => {
    const view = await mountView({ sid: 5, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    const src = rowByName("local", "a.txt");
    src.dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    const remoteBody = pane("remote").querySelector(".sp-body")!;
    remoteBody.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true }));
    expect(remoteBody.classList.contains("drop-hot")).toBe(true);
    remoteBody.dispatchEvent(new MouseEvent("dragleave", { bubbles: true }));
    expect(remoteBody.classList.contains("drop-hot")).toBe(false);
    remoteBody.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true }));
    expect(remoteBody.classList.contains("drop-hot")).toBe(true);
    src.dispatchEvent(new MouseEvent("dragend", { bubbles: true }));
    await flushView();
    expect(remoteBody.classList.contains("drop-hot")).toBe(false);
    expect(document.querySelectorAll(".sp-row.dragging").length).toBe(0);
  });

  it("Shift 范围选择的锚点已被过滤掉时:不误选,也不崩", async () => {
    listLocal.mockResolvedValue({ path: "/home/u", entries: [FILE("a.txt"), FILE("b.txt")] });
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local").length).toBe(2));
    clickRow("local", "a.txt"); // anchor = a.txt
    await flushView();
    const filterInput = pane("local").querySelector(".sp-filter input") as HTMLInputElement;
    filterInput.value = "b";
    filterInput.dispatchEvent(new Event("input"));
    await flushView();
    expect(listedNames("local")).toEqual(["b.txt"]);
    clickRow("local", "b.txt", { shiftKey: true }); // anchor 不在当前列表 → i<0,守卫生效
    await flushView();
    expect([...document.querySelectorAll(".sp-row.sel .nm")].map((n) => n.textContent)).toEqual([]);
  });

  it("⌘/Ctrl 再点同一行取消选中(切换语义)", async () => {
    listLocal.mockResolvedValue({ path: "/home/u", entries: [FILE("a.txt"), FILE("b.txt")] });
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local").length).toBe(2));
    clickRow("local", "a.txt");
    await flushView();
    expect([...document.querySelectorAll(".sp-row.sel .nm")].map((n) => n.textContent)).toEqual(["a.txt"]);
    clickRow("local", "a.txt", { ctrlKey: true });
    await flushView();
    expect(document.querySelectorAll(".sp-row.sel").length).toBe(0);
  });

  it("重复打开 Actions 菜单只保留一个(旧菜单先被移除)", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rows("local")).toBeGreaterThan(0));
    actionsMenu("local");
    actionsMenu("local");
    expect(document.querySelectorAll(".sp-menu").length).toBe(1);
  });

  it("多选态菜单 Clear selection:清空选中并重绘", async () => {
    listLocal.mockResolvedValue({ path: "/home/u", entries: [FILE("a.txt"), FILE("b.txt")] });
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local").length).toBe(2));
    clickRow("local", "a.txt");
    clickRow("local", "b.txt", { ctrlKey: true });
    await flushView();
    expect(document.querySelectorAll(".sp-row.sel").length).toBe(2);
    actionsMenu("local");
    click(menuItem("Clear selection"));
    await flushView();
    expect(document.querySelectorAll(".sp-row.sel").length).toBe(0);
    expect(document.querySelector(".sp-menu")).toBeNull();
  });

  it("多选后刷新导致选中项消失:Delete 2 items 不误删(空目标直接返回)", async () => {
    listLocal.mockResolvedValue({ path: "/home/u", entries: [FILE("a.txt"), FILE("b.txt"), FILE("c.txt")] });
    const view = await mountView({ sid: 2, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local").length).toBe(3));
    clickRow("local", "a.txt");
    clickRow("local", "b.txt", { ctrlKey: true });
    await flushView();

    /* 目录内容被外部改掉:a/b 已不存在;但 selSet 仍是 {a,b} */
    listLocal.mockResolvedValueOnce({ path: "/home/u", entries: [FILE("c.txt")] });
    const arrows = [...pane("local").querySelectorAll<HTMLElement>(".sp-crumbs .sp-arrow")];
    click(arrows[1]); // › Reload
    await vi.waitFor(() => expect(listedNames("local")).toEqual(["c.txt"]));

    const bannersBefore = bannerTexts().length;
    actionsMenu("local");
    click(menuItem("Delete 2 items"));
    await flushView();
    expect(rmLocal).not.toHaveBeenCalled();
    expect(bannerTexts().length).toBe(bannersBefore); // 没有 "Deleted 0/2"
  });

  it("拖拽方向:远端条目拖到本地栏 = 下载", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [FILE("x.bin", 10)] });
    const view = await mountView({ sid: 5, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote")).toContain("x.bin"));
    rowByName("remote", "x.bin").dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    const localBody = pane("local").querySelector(".sp-body")!;
    localBody.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true }));
    localBody.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(downloadRemote).toHaveBeenCalledWith(5, "/root/x.bin", "/home/u/x.bin"));
  });

  it("本地多选 Upload 2 items:逐条上传并刷新", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [] });
    listLocal.mockResolvedValue({ path: "/home/u", entries: [FILE("a.txt")] });
    const view = await mountView({ sid: 5, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local").length).toBe(1));
    clickRow("local", "a.txt");
    await flushView();
    actionsMenu("local");
    click(menuItem("Upload →"));
    await vi.waitFor(() => expect(uploadRemote).toHaveBeenCalledTimes(1));

    /* 再选两项走批量路径 */
    listLocal.mockResolvedValue({ path: "/home/u", entries: [FILE("a.txt"), FILE("b.txt")] });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local").length).toBe(2));
    clickRow("local", "a.txt");
    clickRow("local", "b.txt", { ctrlKey: true });
    await flushView();
    actionsMenu("local");
    expect(menuLabels()).toContain("Upload 2 items →");
    click(menuItem("Upload 2 items →"));
    await vi.waitFor(() => expect(uploadRemote).toHaveBeenCalledTimes(3));
    expect(uploadRemote).toHaveBeenNthCalledWith(2, 5, "/home/u/a.txt", "/root/a.txt");
    expect(uploadRemote).toHaveBeenNthCalledWith(3, 5, "/home/u/b.txt", "/root/b.txt");
  });

  it("操作/传输失败且原因是字符串:横幅显示原始文本", async () => {
    const view = await mountView({ sid: 7, label: "node-1" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));

    mkLocal.mockRejectedValueOnce("permission string");
    actionsMenu("local");
    click(menuItem("New folder"));
    await openPromptDialog();
    answerPrompt("dir-x");
    await vi.waitFor(() => expect(lastBanner()).toBe("permission string"));

    clickRow("local", "a.txt");
    await flushView();
    uploadRemote.mockRejectedValueOnce("network string");
    actionsMenu("local");
    click(menuItem("Upload →"));
    await vi.waitFor(() => expect(bannerTexts()).toContain("network string"));
  });

  it("远端空态点 Download:没有会话时给原因、不发桥调用", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-empty")).toBeTruthy());
    actionsMenu("remote");
    click(menuItem("← Download"));
    await flushView();
    expect(downloadRemote).not.toHaveBeenCalled();
    expect(lastBanner()).toBe("Remote pane is not bound to a session");
  });

  it("第二个弹窗打开时替换掉第一个(不叠层)", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rows("local")).toBeGreaterThan(0));
    actionsMenu("local");
    click(menuItem("New folder"));
    await openPromptDialog();

    actionsMenu("local");
    click(menuItem("New folder"));
    await flushView();
    expect(document.querySelectorAll(".prompt-dlg").length).toBe(1);
    answerPrompt("second-dir");
    await vi.waitFor(() => expect(mkLocal).toHaveBeenCalledWith("/home/u/second-dir"));
    expect(document.querySelector(".prompt-dlg")).toBeNull();
  });

  it("输入弹窗:✕ / 点遮罩 / 空输入回车 都取消(不调桥)", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rows("local")).toBeGreaterThan(0));

    actionsMenu("local");
    click(menuItem("New folder"));
    let dlg = await openPromptDialog();
    click(dlg.querySelector(".dd-x"));
    await flushView();
    expect(document.querySelector(".prompt-dlg")).toBeNull();
    expect(mkLocal).not.toHaveBeenCalled();

    actionsMenu("local");
    click(menuItem("New folder"));
    dlg = await openPromptDialog();
    dlg.dispatchEvent(new MouseEvent("click", { bubbles: true })); // target = 遮罩本身
    await flushView();
    expect(document.querySelector(".prompt-dlg")).toBeNull();
    expect(mkLocal).not.toHaveBeenCalled();

    actionsMenu("local");
    click(menuItem("New folder"));
    dlg = await openPromptDialog();
    (dlg.querySelector(".pd-input") as HTMLInputElement).value = "   ";
    dlg.querySelector(".pd-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushView();
    expect(document.querySelector(".prompt-dlg")).toBeNull();
    expect(mkLocal).not.toHaveBeenCalled();
  });

  it("确认弹窗:✕ / 点遮罩 都按取消处理(不调桥)", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    clickRow("local", "a.txt");
    await flushView();

    actionsMenu("local");
    click(menuItem("Delete"));
    let dlg = await openPromptDialog();
    click(dlg.querySelector(".dd-x"));
    await flushView();
    expect(rmLocal).not.toHaveBeenCalled();

    actionsMenu("local");
    click(menuItem("Delete"));
    dlg = await openPromptDialog();
    dlg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushView();
    expect(rmLocal).not.toHaveBeenCalled();
    expect(document.querySelector(".prompt-dlg")).toBeNull();
  });

  it("进度:total=0 的 done 按 100% 画;error 没有原因时显示 failed;横幅 6s 自动移除", async () => {
    const view = await mountView(null);
    view.onShow();
    await flushView();
    vi.useFakeTimers();
    try {
      emitProgress({ sid: 1, jobId: 21, dir: "up", file: "zero.bin", bytes: 9, total: 0, state: "done" });
      expect(document.querySelector(".sftp-queue .job .jfill")!.getAttribute("style")).toContain("100%");
      expect(document.querySelector(".sftp-queue .job .jstat")!.textContent).toBe("9 B done");

      emitProgress({ sid: 1, jobId: 22, dir: "up", file: "bad.bin", bytes: 0, total: 0, state: "error" });
      const errRows = [...document.querySelectorAll<HTMLElement>(".sftp-queue .job.err")];
      expect(errRows[0].querySelector(".jstat")!.textContent).toBe("failed");

      actionsMenu("remote");
      click(menuItem("← Download")); // 未绑定会话 → banner
      expect(bannerTexts()).toContain("Remote pane is not bound to a session");
      expect(document.querySelectorAll(".sftp-queue .job").length).toBe(3);
      await vi.advanceTimersByTimeAsync(6000);
      /* 横幅(6s)被移除;错误任务行不是横幅,保留 */
      expect(bannerTexts()).not.toContain("Remote pane is not bound to a session");
      expect(document.querySelectorAll(".sftp-queue .job").length).toBe(1);
      expect(document.querySelector(".sftp-queue .jstat")!.textContent).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ================= 引擎接线:策略 / Finder 拖入 / ⌥ 拖出 / 队列取消 ================= */

describe("SFTP 视图 · 引擎接线", () => {
  const dropWithFiles = (el: Element, files: File[]): void => {
    const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
    ev.dataTransfer = { files };
    el.dispatchEvent(ev);
  };

  it("冲突策略:菜单里可循环切换并持久化,传输时带上当前策略", async () => {
    const view = await mountView({ sid: 3, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    actionsMenu("local");
    expect(menuItem("On conflict: overwrite")).toBeTruthy();
    click(menuItem("On conflict: overwrite"));
    await flushView();
    expect(lastBanner()).toBe("On conflict: skip");
    expect(localStorage.getItem("sshkit.sftpConflict")).toBe("skip");

    clickRow("local", "a.txt");
    await flushView();
    actionsMenu("local");
    click(menuItem("Upload →"));
    await vi.waitFor(() => expect(uploadRemote).toHaveBeenCalledWith(3, "/home/u/a.txt", "/root/a.txt"));
    expect(transferPolicies).toEqual(["skip"]);
  });

  it("Finder 拖入远端栏:逐个文件上传到当前远端目录", async () => {
    const view = await mountView({ sid: 4, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    pathForFile.mockReturnValueOnce("/tmp/one.bin").mockReturnValueOnce("/tmp/two.bin");
    dropWithFiles(pane("remote").querySelector(".sp-body")!, [
      new File(["a"], "one.bin"), new File(["b"], "two.bin"),
    ]);
    await vi.waitFor(() => expect(uploadRemote).toHaveBeenCalledTimes(2));
    expect(uploadRemote).toHaveBeenNthCalledWith(1, 4, "/tmp/one.bin", "/root/one.bin");
    expect(uploadRemote).toHaveBeenNthCalledWith(2, 4, "/tmp/two.bin", "/root/two.bin");
  });

  it("Finder 拖到本地栏:只提示已在本地,不上传", async () => {
    const view = await mountView({ sid: 5, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    dropWithFiles(pane("local").querySelector(".sp-body")!, [new File(["a"], "x.bin")]);
    await flushView();
    expect(uploadRemote).not.toHaveBeenCalled();
    expect(lastBanner()).toContain("already local");
  });

  it("⌥ + 拖本地文件 → 原生拖到 Finder;普通拖不触发", async () => {
    const view = await mountView({ sid: 6, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    const row = rowByName("local", "a.txt");
    row.dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    expect(startDrag).not.toHaveBeenCalled();
    row.dispatchEvent(new MouseEvent("dragstart", { bubbles: true, altKey: true }));
    expect(startDrag).toHaveBeenCalledWith("/home/u/a.txt");
  });

  it("传输队列:每条任务可取消,进度显示 i/n", async () => {
    const view = await mountView({ sid: 8, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    progressCbs.forEach((cb) => cb({
      sid: 8, jobId: 42, dir: "up", file: "a.txt", bytes: 5, total: 10,
      state: "active", relPath: "a.txt", index: 1, count: 3, overallBytes: 5, overallTotal: 30,
    }));
    const row = document.querySelector(".sftp-queue .job")! as HTMLElement;
    expect(row.querySelector(".jname")!.textContent).toContain("(1/3)");
    click(row.querySelector(".jx")!);
    await vi.waitFor(() => expect(cancelJob).toHaveBeenCalledWith(42));
    expect(document.querySelector(".sftp-queue .job")).toBeNull();
  });

  it("跳过的文件/特殊项:传输后给出横幅", async () => {
    const view = await mountView({ sid: 9, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    const treeOk = { jobId: 1, files: 1, skippedFiles: 2, skippedEntries: 1, bytes: 0, cancelled: false };
    uploadRemote.mockResolvedValueOnce({ ...treeOk });
    clickRow("local", "a.txt");
    await flushView();
    actionsMenu("local");
    click(menuItem("Upload →"));
    /* 两条提示都会出现:banner 是 prepend,所以"特殊项"(后发)在最前,"已存在文件"在后 */
    await vi.waitFor(() => expect(bannerTexts()[0]).toBe("Skipped 1 special entries (symlinks etc.)"));
    expect(lastBanner()).toBe("Skipped 2 existing file(s)");
  });
});

describe("SFTP 视图 · 拖入与队列边界", () => {
  const dropWith = (el: Element, files: File[]): void => {
    const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
    ev.dataTransfer = { files };
    el.dispatchEvent(ev);
  };

  it("取不到真实路径的文件被跳过;Windows 路径也能取出文件名;上传失败给横幅", async () => {
    const view = await mountView({ sid: 11, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    pathForFile
      .mockReturnValueOnce("")
      .mockReturnValueOnce("C:\\Users\\me\\win.bin")
      .mockReturnValueOnce("/tmp/boom.bin");
    uploadRemote.mockRejectedValueOnce(new Error("disk full"));
    dropWith(pane("remote").querySelector(".sp-body")!, [
      new File(["0"], "empty-path.bin"), new File(["1"], "win.bin"), new File(["2"], "boom.bin"),
    ]);
    await vi.waitFor(() => expect(lastBanner()).toContain("disk full"));
    expect(uploadRemote).toHaveBeenCalledWith(11, "C:\\Users\\me\\win.bin", "/root/win.bin");
    expect(uploadRemote).toHaveBeenCalledTimes(2);
  });

  it("冲突策略:存了非法值时回落覆盖;存 rename 时显示 rename", async () => {
    localStorage.setItem("sshkit.sftpConflict", "bogus");
    const view = await mountView({ sid: 12, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    actionsMenu("local");
    expect(menuItem("On conflict: overwrite")).toBeTruthy();
    localStorage.setItem("sshkit.sftpConflict", "rename");
    click(menuItem("On conflict: overwrite"));
    await flushView();
    expect(lastBanner()).toBe("On conflict: overwrite");
  });

  it("队列:cancelled / skipped 状态收尾;total=0 且无 index 时不显示 i/n", async () => {
    const view = await mountView({ sid: 13, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    const base = { sid: 13, jobId: 71, dir: "up", file: "x", bytes: 0, total: 0, state: "active" };
    progressCbs.forEach((cb) => cb(base));
    expect(document.querySelector(".sftp-queue .jname")!.textContent).toBe("⬆ x");
    progressCbs.forEach((cb) => cb({ ...base, state: "skipped" }));
    await vi.waitFor(() => expect(document.querySelector(".sftp-queue .job")!.className).toContain("done"));
    progressCbs.forEach((cb) => cb({ ...base, jobId: 72, state: "cancelled" }));
    await flushView();
    expect(document.body.textContent).toContain("cancelled");
    /* 取消态用独立 class:进度条保留实际比例(不能画成 100% 像已完成) */
    expect(document.querySelector(".sftp-queue .job.cancelled")).toBeTruthy();
  });
});

describe("SFTP 视图 · 剩余分支", () => {
  const dropWith = (el: Element, files: File[]): void => {
    const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
    ev.dataTransfer = { files };
    el.dispatchEvent(ev);
  };

  it("没有会话时把文件拖进远端栏:提示未绑定,不发请求", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-empty")).toBeTruthy());
    dropWith(pane("remote").querySelector(".sp-body")!, [new File(["a"], "x.bin")]);
    await flushView();
    expect(lastBanner()).toBe("Remote pane is not bound to a session");
    expect(uploadRemote).not.toHaveBeenCalled();
  });

  it("拖入的上传失败:横幅显示原因", async () => {
    const view = await mountView({ sid: 21, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    pathForFile.mockReturnValue("/tmp/deny.bin");
    uploadRemote.mockRejectedValue(new Error("permission denied"));
    dropWith(pane("remote").querySelector(".sp-body")!, [new File(["a"], "deny.bin")]);
    await vi.waitFor(() => expect(lastBanner()).toContain("permission denied"));
  });

  it("队列:有 index 但只有 1 个文件时不加 i/n;done 且 total=0 时进度按 100%", async () => {
    const view = await mountView({ sid: 22, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    const p1 = { sid: 22, jobId: 91, dir: "down", file: "one", bytes: 0, total: 0, state: "active",
      relPath: "one", index: 1, count: 1, overallBytes: 0, overallTotal: 0 };
    progressCbs.forEach((cb) => cb(p1));
    expect(document.querySelector(".sftp-queue .jname")!.textContent).toBe("⬇ one");
    progressCbs.forEach((cb) => cb({ ...p1, state: "done" }));
    await vi.waitFor(() => expect((document.querySelector(".sftp-queue .jfill") as HTMLElement).style.width).toBe("100%"));
  });
});

describe("SFTP 视图 · 最后几个分支", () => {
  it("策略标签:localStorage 为 skip 时菜单显示 skip(走表的 skip 项)", async () => {
    localStorage.setItem("sshkit.sftpConflict", "skip");
    const view = await mountView({ sid: 31, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    actionsMenu("local");
    expect(menuItem("On conflict: skip")).toBeTruthy();
  });

  it("错误对象没有 message 时横幅用原始值", async () => {
    const view = await mountView({ sid: 32, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rowNames("local")).toContain("a.txt"));
    uploadRemote.mockRejectedValueOnce("weird-failure");
    clickRow("local", "a.txt");
    await flushView();
    actionsMenu("local");
    click(menuItem("Upload →"));
    await vi.waitFor(() => expect(lastBanner()).toBe("weird-failure"));
  });
});

describe("SFTP 视图 · 拖入时的非标准错误", () => {
  it("拖入上传被以字符串拒绝:横幅显示原始值", async () => {
    const view = await mountView({ sid: 33, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(rows("remote")).toBeGreaterThan(0));
    pathForFile.mockReturnValue("/tmp/raw.bin");
    uploadRemote.mockRejectedValueOnce("raw-drop-error");
    const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
    ev.dataTransfer = { files: [new File(["a"], "raw.bin")] };
    pane("remote").querySelector(".sp-body")!.dispatchEvent(ev);
    await vi.waitFor(() => expect(lastBanner()).toBe("raw-drop-error"));
  });
});

/* ================= 行内右键菜单 + 改权限 ================= */

describe("SFTP 视图 · 行内右键菜单", () => {
  const rightClick = (which: "local" | "remote", name: string): void => {
    const row = rowByName(which, name);
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  };

  it("右键文件:弹出菜单(下载/重命名/改权限/删除)", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [FILE("x.bin", 100)] });
    const view = await mountView({ sid: 41, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote")).toContain("x.bin"));
    rightClick("remote", "x.bin");
    const labels = [...document.querySelectorAll(".sp-menu button")].map((b) => b.textContent?.trim());
    expect(labels).toContain("← Download");
    expect(labels).toContain("Rename");
    expect(labels).toContain("Change permissions");
    expect(labels).toContain("Delete");
  });

  it("右键目录:给出打开而不是下载", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [DIR("pkg")] });
    const view = await mountView({ sid: 42, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote")).toContain("pkg"));
    rightClick("remote", "pkg");
    const labels = [...document.querySelectorAll(".sp-menu button")].map((b) => b.textContent?.trim());
    expect(labels).toContain("Open");
    expect(labels).not.toContain("← Download");
  });

  it("右键菜单删除:确认后调桥并刷新", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [FILE("x.bin", 100)] });
    const view = await mountView({ sid: 43, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote")).toContain("x.bin"));
    rightClick("remote", "x.bin");
    click([...document.querySelectorAll(".sp-menu button")].find((b) => b.textContent?.trim() === "Delete")!);
    await openPromptDialog();
    answerConfirm(true);
    await vi.waitFor(() => expect(rmRemote).toHaveBeenCalledWith(43, "/root/x.bin"));
  });

  it("右键菜单重命名:输入新名字后调桥", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [FILE("x.bin", 100)] });
    const view = await mountView({ sid: 44, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote")).toContain("x.bin"));
    rightClick("remote", "x.bin");
    click([...document.querySelectorAll(".sp-menu button")].find((b) => b.textContent?.trim() === "Rename")!);
    await openPromptDialog();
    answerPrompt("y.bin");
    await vi.waitFor(() => expect(renRemote).toHaveBeenCalledWith(44, "/root/x.bin", "/root/y.bin"));
  });

  it("改权限:预填当前 644,改 600 后调桥(远端与本地各一条)", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [FILE("x.bin", 100)] });
    const view = await mountView({ sid: 45, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote")).toContain("x.bin"));
    rightClick("remote", "x.bin");
    click([...document.querySelectorAll(".sp-menu button")].find((b) => b.textContent?.trim() === "Change permissions")!);
    await vi.waitFor(() => expect(document.querySelector(".prompt-dlg")).toBeTruthy());
    const input = document.querySelector(".prompt-dlg .pd-input") as HTMLInputElement;
    expect(input.value).toBe("644");
    input.value = "600";
    click(document.querySelector(".prompt-dlg .dd-ok")!);
    await vi.waitFor(() => expect(chmodRemote).toHaveBeenCalledWith(45, "/root/x.bin", 0o600));

    /* 本地栏同样支持(本地文件走 local.chmod) */
    rightClick("local", "a.txt");
    click([...document.querySelectorAll(".sp-menu button")].find((b) => b.textContent?.trim() === "Change permissions")!);
    await vi.waitFor(() => expect(document.querySelector(".prompt-dlg")).toBeTruthy());
    (document.querySelector(".prompt-dlg .pd-input") as HTMLInputElement).value = "640";
    click(document.querySelector(".prompt-dlg .dd-ok")!);
    await vi.waitFor(() => expect(chmodLocal).toHaveBeenCalledWith("/home/u/a.txt", 0o640));
  });

  it("权限输入非法 → 提示且不调桥", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [FILE("x.bin", 100)] });
    const view = await mountView({ sid: 46, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote")).toContain("x.bin"));
    rightClick("remote", "x.bin");
    click([...document.querySelectorAll(".sp-menu button")].find((b) => b.textContent?.trim() === "Change permissions")!);
    await vi.waitFor(() => expect(document.querySelector(".prompt-dlg")).toBeTruthy());
    answerPrompt("abc");
    await vi.waitFor(() => expect(lastBanner()).toBe("Permissions must be 3–4 octal digits, e.g. 644"));
    expect(chmodRemote).not.toHaveBeenCalled();
  });

  it("多选时右键:删除/改权限作用于全部选中项", async () => {
    listLocal.mockResolvedValue({ path: "/home/u", entries: [FILE("a.txt"), FILE("b.txt")] });
    const view = await mountView({ sid: 47, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local")).toContain("a.txt"));
    /* click() 助手不带修饰键,多选要用真实 MouseEvent(metaKey) */
    rowByName("local", "a.txt").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    rowByName("local", "b.txt").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    rightClick("local", "b.txt");
    const labels = [...document.querySelectorAll(".sp-menu button")].map((b) => b.textContent?.trim());
    expect(labels).toContain("Delete 2 items");
    expect(labels).toContain("Change permissions for 2 items");
    click([...document.querySelectorAll(".sp-menu button")].find((b) => b.textContent?.trim() === "Change permissions for 2 items")!);
    await vi.waitFor(() => expect(document.querySelector(".prompt-dlg")).toBeTruthy());
    (document.querySelector(".prompt-dlg .pd-input") as HTMLInputElement).value = "600";
    click(document.querySelector(".prompt-dlg .dd-ok")!);
    await vi.waitFor(() => expect(chmodLocal).toHaveBeenCalledTimes(2));
  });
});

describe("SFTP 视图 · 右键菜单各动作与 chmod 边界", () => {
  const rightClick = (which: "local" | "remote", name: string): void => {
    rowByName(which, name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  };
  const menuClick = (label: string): void => {
    const btn = [...document.querySelectorAll(".sp-menu button")].find((b) => b.textContent?.trim() === label);
    if (!btn) throw new Error("menu item not found: " + label);
    click(btn);
  };
  const actionsClick = (label: string): void => {
    actionsMenu("local");
    menuClick(label);
  };

  it("目录右键 Open:进入该目录并刷新", async () => {
    const view = await mountView({ sid: 51, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local")).toContain("docs"));
    rightClick("local", "docs");
    menuClick("Open");
    await vi.waitFor(() => expect(listLocal).toHaveBeenCalledWith("/home/u/docs"));
  });

  it("文件右键 Upload →:走传输", async () => {
    const view = await mountView({ sid: 52, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local")).toContain("a.txt"));
    rightClick("local", "a.txt");
    menuClick("Upload →");
    await vi.waitFor(() => expect(uploadRemote).toHaveBeenCalledWith(52, "/home/u/a.txt", "/root/a.txt"));
  });

  it("多选右键:删除 N 项 / 清除选择 都能用", async () => {
    listLocal.mockResolvedValue({ path: "/home/u", entries: [FILE("a.txt"), FILE("b.txt")] });
    const view = await mountView({ sid: 53, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local")).toContain("a.txt"));
    rowByName("local", "a.txt").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    rowByName("local", "b.txt").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    rightClick("local", "b.txt");
    menuClick("Delete 2 items");
    /* 批量删除不弹确认(与 Actions 菜单里的行为一致),删完给横幅 */
    await vi.waitFor(() => expect(rmLocal).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(lastBanner()).toBe("Deleted 2/2 items"));

    rowByName("local", "a.txt").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    rowByName("local", "b.txt").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    rightClick("local", "b.txt");
    menuClick("Clear selection");
    expect(document.querySelectorAll(".sp-row.sel").length).toBe(0);
  });

  it("Actions 菜单里的「修改权限」在没有选中项时只提示", async () => {
    const view = await mountView({ sid: 54, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local")).toContain("a.txt"));
    actionsMenu("local");
    menuClick("Change permissions");
    await vi.waitFor(() => expect(lastBanner()).toBe("Select an item in the pane first"));
    expect(chmodLocal).not.toHaveBeenCalled();
  });

  it("远端未绑定会话时改权限:提示而不是报错", async () => {
    const view = await mountView(null);
    view.onShow();
    await vi.waitFor(() => expect(document.querySelector(".sftp-empty")).toBeTruthy());
    actionsMenu("remote");
    menuClick("Change permissions");
    await vi.waitFor(() => expect(lastBanner()).toBe("Remote pane is not bound to a session"));
  });

  it("取消权限输入框 / 权限服务报错:都不改东西", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [FILE("x.bin", 100)] });
    const view = await mountView({ sid: 55, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote")).toContain("x.bin"));
    rightClick("remote", "x.bin");
    menuClick("Change permissions");
    await openPromptDialog();
    answerPrompt(null);
    await flushView();
    expect(chmodRemote).not.toHaveBeenCalled();

    chmodRemote.mockRejectedValueOnce(new Error("perm denied"));
    rightClick("remote", "x.bin");
    menuClick("Change permissions");
    await openPromptDialog();
    answerPrompt("600");
    await vi.waitFor(() => expect(lastBanner()).toContain("perm denied"));
  });
});

describe("SFTP 视图 · 右键下载与错误文本", () => {
  it("远端文件右键 ← Download:走下载", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [FILE("x.bin", 100)] });
    const view = await mountView({ sid: 61, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote")).toContain("x.bin"));
    rowByName("remote", "x.bin").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const btn = [...document.querySelectorAll(".sp-menu button")].find((b) => b.textContent?.trim() === "← Download");
    expect(btn).toBeTruthy();
    click(btn!);
    await vi.waitFor(() => expect(downloadRemote).toHaveBeenCalledWith(61, "/root/x.bin", "/home/u/x.bin"));
  });

  it("改权限失败且错误没有 message:横幅显示原始值", async () => {
    listRemote.mockResolvedValue({ path: "/root", entries: [FILE("x.bin", 100)] });
    const view = await mountView({ sid: 62, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("remote")).toContain("x.bin"));
    chmodRemote.mockRejectedValueOnce("raw-chmod-error");
    rowByName("remote", "x.bin").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    click([...document.querySelectorAll(".sp-menu button")].find((b) => b.textContent?.trim() === "Change permissions")!);
    await openPromptDialog();
    answerPrompt("600");
    await vi.waitFor(() => expect(lastBanner()).toBe("raw-chmod-error"));
  });
});

describe("SFTP 视图 · Actions 菜单的刷新", () => {
  it("两个栏的 Reload 都会重新拉列表(不改变当前目录)", async () => {
    const view = await mountView({ sid: 71, label: "n" });
    view.onShow();
    await vi.waitFor(() => expect(listedNames("local")).toContain("a.txt"));
    const before = listLocal.mock.calls.length;
    actionsMenu("local");
    expect(menuItem("Reload")).toBeTruthy();
    click(menuItem("Reload"));
    await vi.waitFor(() => expect(listLocal.mock.calls.length).toBe(before + 1));
    expect(listLocal).toHaveBeenLastCalledWith("/home/u");   // 目录没变

    const beforeR = listRemote.mock.calls.length;
    actionsMenu("remote");
    click(menuItem("Reload"));
    await vi.waitFor(() => expect(listRemote.mock.calls.length).toBe(beforeR + 1));
  });
});
