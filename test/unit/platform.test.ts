import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ElectronMock } from "../helpers/electron-mock";
import { resolveCwd, resolveShell } from "../../src/main/pty";

/**
 * 平台相关逻辑的**双分支**覆盖。
 *
 * 为什么单独抽函数测:CI 在 macOS/Linux/Windows 三个平台跑覆盖率,若代码直接读
 * `process.platform`,每个平台必然有另一半分支走不到 → 100% 阈值跨平台不可能成立。
 * 把平台/环境作为参数传入后,两个分支在任何机器上都能被覆盖。
 */
let em: ElectronMock;
/* Linux 上真 keytar 链接 libsecret,缺库时 import 阶段就崩;这份用例只关心平台分支,不需要钥匙串 */
vi.mock("keytar", () => ({
  default: {
    setPassword: async () => undefined,
    getPassword: async () => null,
    deletePassword: async () => false,
  },
}));
vi.mock("electron", async () => {
  const { createElectronMock } = await import("../helpers/electron-mock");
  em = createElectronMock();
  return em.module;
});

let installAppMenu: typeof import("../../src/main/main").installAppMenu;
let windowChrome: typeof import("../../src/main/main").windowChrome;
let shouldQuitOnAllClosed: typeof import("../../src/main/main").shouldQuitOnAllClosed;
let installAboutPanel: typeof import("../../src/main/main").installAboutPanel;
let setDockIcon: typeof import("../../src/main/main").setDockIcon;

beforeAll(async () => {
  const mod = await import("../../src/main/main");
  installAppMenu = mod.installAppMenu;
  windowChrome = mod.windowChrome;
  shouldQuitOnAllClosed = mod.shouldQuitOnAllClosed;
  installAboutPanel = mod.installAboutPanel;
  setDockIcon = mod.setDockIcon;
});

describe("resolveShell:按平台选默认 shell", () => {
  it("Windows 用 COMSPEC(即使继承到 POSIX 的 $SHELL 也不用)", () => {
    expect(resolveShell("win32", { COMSPEC: "C:\\Windows\\system32\\cmd.exe", SHELL: "/usr/bin/bash" }))
      .toBe("C:\\Windows\\system32\\cmd.exe");
    expect(resolveShell("win32", {})).toBe("powershell.exe");
  });

  it("POSIX 平台用 $SHELL,缺失时回落到 /bin/zsh", () => {
    expect(resolveShell("darwin", { SHELL: "/bin/bash" })).toBe("/bin/bash");
    expect(resolveShell("linux", { SHELL: "/usr/bin/fish" })).toBe("/usr/bin/fish");
    expect(resolveShell("darwin", {})).toBe("/bin/zsh");
    expect(resolveShell("linux", { COMSPEC: "C:\\Windows\\cmd.exe" })).toBe("/bin/zsh");
  });
});

describe("resolveCwd:显式 → HOME → USERPROFILE → 主目录", () => {
  it("显式 cwd 优先", () => {
    expect(resolveCwd("/tmp/project", { HOME: "/home/u" }, () => "/h")).toBe("/tmp/project");
  });

  it("没有显式值时依次回退,覆盖 Windows(无 HOME)与兜底", () => {
    expect(resolveCwd(undefined, { HOME: "/home/u" }, () => "/h")).toBe("/home/u");
    expect(resolveCwd(undefined, { USERPROFILE: "C:\\Users\\u" }, () => "C:\\Users\\u")).toBe("C:\\Users\\u");
    expect(resolveCwd(undefined, {}, () => "/root")).toBe("/root");
  });
});

describe("windowChrome:macOS 用 hiddenInset,Windows 用无边框", () => {
  it("darwin 加 titleBarStyle;win32 去掉原生边框(frame:false);linux 暂不改动", () => {
    /* 交通灯必须显式给位置:hiddenInset 的默认位置比原版更靠上(实测中心 y≈18 vs 原版 25),
       用户一眼看出"飘着"。这里锁住精确值(x/y 是按钮组左上角)。 */
    expect(windowChrome("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 19 },
    });
    /* 期望变更(2026-10-22):原来这里期望 `{}` 是错的。原版 Termius 的 app.asar 里主窗口
       创建参数是 `frame: !1`(三平台一致),Windows 上保留系统边框会多出一条原生标题栏;
       正确语义是无边框 + 渲染层自绘窗口按钮,依据见 src/main/main.ts 的 windowChrome 注释。 */
    expect(windowChrome("win32")).toEqual({ frame: false });
    expect(windowChrome("linux")).toEqual({});
  });
});

describe("installAppMenu:非 macOS 不装应用菜单", () => {
  it("linux/win32 直接清空应用菜单(不让系统菜单吃掉快捷键)", () => {
    em.menu.built.length = 0;
    em.menu.applied.length = 0;
    installAppMenu("linux");
    expect(em.menu.built).toHaveLength(0);
    expect(em.menu.applied).toEqual([null]);

    installAppMenu("win32");
    expect(em.menu.built).toHaveLength(0);
  });

  it("darwin 构建并安装应用菜单(含偏好设置入口)", () => {
    em.menu.built.length = 0;
    em.menu.applied.length = 0;
    installAppMenu("darwin");
    expect(em.menu.built).toHaveLength(1);
    const template = em.menu.built[0] as Array<{ label?: string; submenu?: unknown[] }>;
    expect(template.length).toBeGreaterThan(0);
    expect(em.menu.applied).toHaveLength(1);
  });
});

describe("关窗口是否退出应用", () => {
  it("macOS 不退出(留在 Dock),Windows/Linux 退出", () => {
    /* macOS 约定:关窗口应用继续活着,点 Dock 图标能重开(activate);
       其余平台按惯例退出。用户之前"一关窗口应用就没了"就是这个无条件 quit 造成的。 */
    expect(shouldQuitOnAllClosed("darwin")).toBe(false);
    expect(shouldQuitOnAllClosed("win32")).toBe(true);
    expect(shouldQuitOnAllClosed("linux")).toBe(true);
  });
});


describe("关于面板", () => {
  it("darwin:写入应用名/版本/Electron/Chromium/Node 与图标路径", () => {
    const app = (em as unknown as { module: { app: { setAboutPanelOptions: { mock: { calls: Array<[Record<string, unknown>]> } } } } }).module.app;
    installAboutPanel("darwin");
    const opts = app.setAboutPanelOptions.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(opts).toEqual(expect.objectContaining({
      applicationName: expect.any(String),
      applicationVersion: expect.any(String),
      version: expect.stringContaining("Electron"),
      credits: expect.stringMatching(/Chromium .* Node /),
      iconPath: expect.stringContaining("icon-1024.png"),
    }));
  });
  it("非 darwin:不做任何事(Windows/Linux 没有这个原生面板)", () => {
    const app = (em as unknown as { module: { app: { setAboutPanelOptions: { mock: { calls: unknown[] } } } } }).module.app;
    const before = app.setAboutPanelOptions.mock.calls.length;
    installAboutPanel("win32");
    installAboutPanel("linux");
    expect(app.setAboutPanelOptions.mock.calls.length).toBe(before);
  });
});

describe("dev 模式 Dock 图标", () => {
  it("darwin:传入图标路径;非 darwin 不调用", () => {
    const calls: string[] = [];
    setDockIcon("darwin", (f) => calls.push(f));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("icon-1024.png");
    setDockIcon("win32", (f) => calls.push(f));
    setDockIcon("linux", (f) => calls.push(f));
    expect(calls).toHaveLength(1);
  });
  it("setIcon 抛错时只告警、不影响启动", () => {
    const warns: unknown[] = [];
    expect(() => setDockIcon("darwin", () => { throw new Error("no dock"); },
      (_m, e) => warns.push(e))).not.toThrow();
    expect(warns).toHaveLength(1);
  });
  it("不传 warn 时走 console.warn 默认值(不静默吞错)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      setDockIcon("darwin", () => { throw new Error("no dock"); });
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});
