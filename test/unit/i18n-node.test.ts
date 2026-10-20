import { describe, expect, it } from "vitest";
import { applyDom, setLocale, tr } from "../../src/shared/i18n";

/**
 * node 环境(没有 document)下的 i18n 行为:
 * 主进程也可能误调 applyDom/setLocale,必须安全降级而不是抛错。
 */
describe("i18n:无 DOM 环境", () => {
  it("没有 document 时 applyDom 直接返回(不去碰 root)", () => {
    const fake = { querySelectorAll: () => { throw new Error("不该被调用"); } } as never;
    expect(() => applyDom(fake)).not.toThrow();
  });

  it("没有 document 时 setLocale 只更新语言,不尝试写 <html lang>", () => {
    expect(() => setLocale("zh")).not.toThrow();
    expect(tr("rail.hosts")).toBe("主机");
    setLocale("en");
    expect(tr("rail.hosts")).toBe("Hosts");
  });
});
