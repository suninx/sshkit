// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { applyDom, setLocale, tr } from "../../src/shared/i18n";

/**
 * i18n 的 DOM 侧行为(jsdom 环境才能覆盖):
 * setLocale 要把语言写到 <html lang>,applyDom 要把静态标记就地翻译。
 */
beforeEach(() => {
  document.documentElement.removeAttribute("lang");
});

describe("setLocale:语言与 <html lang>", () => {
  it("切到中文写 zh-CN,切回英文写 en", () => {
    expect(document.documentElement.lang).toBe("");
    setLocale("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    setLocale("en");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("applyDom:静态标记就地翻译", () => {
  it("文本 / placeholder / title / aria-label 四类标记都会翻译", () => {
    setLocale("zh");
    const root = document.createElement("div");
    root.innerHTML = `
      <span id="t" data-i18n="rail.hosts"></span>
      <input id="p" data-i18n-placeholder="search.placeholder" />
      <div id="ti" data-i18n-title="menu.close"></button>
      <button id="ar" data-i18n-aria="menu.close"></button>`;
    document.body.append(root);
    applyDom(root);

    const zhHosts = tr("rail.hosts");
    expect(zhHosts).toBe("主机");
    expect(root.querySelector("#t")!.textContent).toBe(zhHosts);
    expect((root.querySelector("#p") as HTMLInputElement).placeholder).toBe(tr("search.placeholder"));
    expect(root.querySelector("#ti")!.getAttribute("title")).toBe(tr("menu.close"));
    expect(root.querySelector("#ar")!.getAttribute("aria-label")).toBe(tr("menu.close"));
    root.remove();
  });

  it("root 本身是带 data-i18n 的 Element 时也会翻译自己(不只后代)", () => {
    setLocale("zh");
    const el = document.createElement("span");
    el.setAttribute("data-i18n", "rail.hosts");
    document.body.append(el);
    applyDom(el);
    expect(el.textContent).toBe("主机");
    el.remove();
  });

  it("root 不是 Element(如 DocumentFragment)时不抛,仍然翻译其后代", () => {
    setLocale("zh");
    const frag = document.createDocumentFragment();
    const span = document.createElement("span");
    span.setAttribute("data-i18n", "rail.hosts");
    frag.append(span);
    expect(() => applyDom(frag)).not.toThrow();
    expect(span.textContent).toBe("主机");
  });
});
