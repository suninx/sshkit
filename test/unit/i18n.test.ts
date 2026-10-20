// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyDom, audit, en, getLocale, LOCALE_OPTIONS, resolveLocale, setLocale, tr, zh,
} from "../../src/shared/i18n";

describe("i18n 目录", () => {
  it("中英文键集合完全一致(不允许某语言缺条目)", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("任何一条文案都非空(空串会渲染成空白,比缺键更难发现)", () => {
    for (const [k, v] of Object.entries(en)) expect(String(v).trim(), `en:${k}`).not.toBe("");
    for (const [k, v] of Object.entries(zh)) expect(String(v).trim(), `zh:${k}`).not.toBe("");
  });

  it("audit() 对当前目录返回空", () => {
    expect(audit()).toEqual([]);
  });

  it("语言选择器提供 跟随系统/中文/English", () => {
    expect(LOCALE_OPTIONS.map((o) => o.value)).toEqual(["system", "zh", "en"]);
  });
});

describe("tr()", () => {
  beforeEach(() => setLocale("en"));

  it("按当前语言返回文案", () => {
    expect(tr("rail.hosts")).toBe("Hosts");
    setLocale("zh");
    expect(tr("rail.hosts")).toBe("主机");
    expect(getLocale()).toBe("zh");
  });

  it("支持 {name} 占位替换(同名占位会全部替换)", () => {
    setLocale("en");
    expect(tr("toast.sentTo", { target: "web-1" })).toBe("Sent to web-1");
    setLocale("zh");
    expect(tr("dlg.hostKeyDesc", { host: "10.0.0.9" })).toContain("10.0.0.9");
  });

  it("缺键时返回键名本身(便于发现漏配,而不是渲染空)", () => {
    expect(tr("no.such.key" as never)).toBe("no.such.key");
  });
});

describe("resolveLocale()", () => {
  it("跟随系统:zh* → zh,其余 → en", () => {
    expect(resolveLocale("system", "zh-CN")).toBe("zh");
    expect(resolveLocale("system", "zh-Hant-TW")).toBe("zh");
    expect(resolveLocale("system", "en-US")).toBe("en");
    expect(resolveLocale("system", "fr-FR")).toBe("en");
    expect(resolveLocale("system", "")).toBe("en");
  });

  it("显式选择优先于系统", () => {
    expect(resolveLocale("zh", "en-US")).toBe("zh");
    expect(resolveLocale("en", "zh-CN")).toBe("en");
  });
});

describe("setLocale / applyDom", () => {
  it("setLocale 同步 <html lang>", () => {
    setLocale("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    setLocale("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("翻译文本/placeholder/title/aria 四类标记", () => {
    document.body.innerHTML = `
      <span id="a" data-i18n="rail.hosts">Hosts</span>
      <input id="b" data-i18n-placeholder="search.placeholder">
      <button id="c" title="x" data-i18n-title="toolbar.tags"></button>
      <button id="d" aria-label="x" data-i18n-aria="toolbar.layout"></button>`;
    setLocale("zh");
    applyDom();
    expect(document.getElementById("a")!.textContent).toBe("主机");
    expect((document.getElementById("b") as HTMLInputElement).placeholder).toContain("查找主机");
    expect(document.getElementById("c")!.getAttribute("title")).toBe("筛选与排序");
    expect(document.getElementById("d")!.getAttribute("aria-label")).toBe("切换布局");
  });

  it("applyDom(document) 不抛错 —— 回归:document 不是 Element,曾在这里抛异常被吞掉", () => {
    setLocale("en");
    expect(() => applyDom()).not.toThrow();
  });

  it("再次切换语言会覆盖已翻译的内容", () => {
    document.body.innerHTML = `<span id="a" data-i18n="rail.logs">Logs</span>`;
    setLocale("zh"); applyDom();
    expect(document.getElementById("a")!.textContent).toBe("日志");
    setLocale("en"); applyDom();
    expect(document.getElementById("a")!.textContent).toBe("Logs");
  });
});

describe("边界:未知 locale 与无 DOM 环境", () => {
  it("未注册的 locale 会退回英文表(不会因为查不到表而崩或返回键名)", () => {
    // 类型上只允许 en/zh,但运行期可能被写脏(settings.json 手改) —— 必须可降级
    setLocale("xx" as never);
    expect(tr("rail.hosts")).toBe("Hosts");
    setLocale("en");
    expect(tr("rail.hosts")).toBe("Hosts");
  });
});
