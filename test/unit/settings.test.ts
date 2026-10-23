import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmDir, tmpDir } from "../helpers/tmp";

let dir: string;

/* settings.ts 在模块级读 app.getPath("userData") → 每个用例前重设 mock 并重置模块缓存 */
vi.mock("electron", () => ({
  app: { getPath: () => vi.mocked((globalThis as { __userData?: string }).__userData ?? "/tmp") },
}));

beforeEach(() => {
  dir = tmpDir("sshkit-settings-");
  (globalThis as { __userData?: string }).__userData = dir;
  vi.resetModules();
});
afterEach(() => rmDir(dir));

async function mod() { return import("../../src/main/settings"); }

describe("settings.json", () => {
  it("默认语言是跟随系统", async () => {
    const { getSettings } = await mod();
    /* MCP 默认关闭、端口 7788:默认值属于设置的一部分,测试跟着期望即可 */
    expect(getSettings()).toEqual({ locale: "system", mcp: { enabled: false, port: 7788, policy: "full" } });
  });

  it("旧版 settings.json 没有 mcp 段:合并默认值(不因升级而读不到设置)", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ locale: "zh" }));
    vi.resetModules();
    const { getSettings } = await mod();
    expect(getSettings()).toEqual({ locale: "zh", mcp: { enabled: false, port: 7788, policy: "full" } });
  });

  it("写入后落盘,重新加载能读回", async () => {
    const { setSetting } = await mod();
    setSetting("locale", "zh");
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    expect(raw.locale).toBe("zh");

    vi.resetModules();
    const again = await mod();
    expect(again.getSettings().locale).toBe("zh");
  });

  it("文件损坏时回落到默认值(不让应用起不来)", async () => {
    fs.writeFileSync(path.join(dir, "settings.json"), "{broken");
    const { getSettings } = await mod();
    expect(getSettings().locale).toBe("system");
  });

  it("写入是原子的:先写临时文件再改名,目录不存在时会自动创建", async () => {
    const nested = path.join(dir, "a", "b");
    (globalThis as { __userData?: string }).__userData = nested;
    const { setSetting } = await mod();
    setSetting("locale", "en");
    expect(JSON.parse(fs.readFileSync(path.join(nested, "settings.json"), "utf8")).locale).toBe("en");
    expect(fs.existsSync(path.join(nested, "settings.json.tmp"))).toBe(false);
  });
});
