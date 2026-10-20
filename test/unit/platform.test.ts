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
vi.mock("electron", async () => {
  const { createElectronMock } = await import("../helpers/electron-mock");
  em = createElectronMock();
  return em.module;
});

let installAppMenu: typeof import("../../src/main/main").installAppMenu;
let windowChrome: typeof import("../../src/main/main").windowChrome;

beforeAll(async () => {
  const mod = await import("../../src/main/main");
  installAppMenu = mod.installAppMenu;
  windowChrome = mod.windowChrome;
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

describe("windowChrome:仅 macOS 加 hiddenInset 标题栏", () => {
  it("darwin 加 titleBarStyle,其它平台返回空对象", () => {
    expect(windowChrome("darwin")).toEqual({ titleBarStyle: "hiddenInset" });
    expect(windowChrome("win32")).toEqual({});
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
