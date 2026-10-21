// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { $, flush, installBridge, loadRendererDom, type BridgeCalls } from "../helpers/renderer";
import { setLocale, tr } from "../../src/shared/i18n";
import type { HostInput, HostRecord } from "../../src/shared/host";

/**
 * hosts.ts 的行为测试:主机列表(分组/排序/搜索/标签过滤/标签芯片/布局)、
 * 新建/编辑表单(认证方式联动、校验、错误提示)、删除确认与放弃修改确认弹窗、
 * 点击卡片连接与活动态标记。
 *
 * 假桥用共享 helper(方法名/返回值与 src/preload/preload.ts 一致);所有桥调用都记录在 calls 里,
 * 断言"界面到底请求了什么"。
 */

type AnyBridge = Record<string, any>;

let hosts: HostRecord[];
let calls: BridgeCalls;
let onConnect: ReturnType<typeof vi.fn>;
let seq: number;
let panel: { refresh: () => Promise<void> };

const HOST = (over: Partial<HostRecord> = {}): HostRecord => ({
  id: "h_alpha",
  name: "alpha",
  group: "prod",
  tags: ["prod"],
  host: "10.0.0.1",
  port: 22,
  username: "root",
  authType: "password",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

async function waitFor(cond: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (cond()) return;
    await flush(2);
  }
  throw new Error(`waitFor timeout: ${label}`);
}

function installFake(storage?: Record<string, string>): void {
  loadRendererDom();
  if (storage) for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
  const b = installBridge({
    "hosts.list": async () => hosts.map((h) => ({ ...h })),
    "hosts.create": async (input) => {
      const rec: HostRecord = {
        ...(input as HostInput),
        id: `h_${++seq}`,
        createdAt: "2026-03-01T00:00:00.000Z",
      };
      hosts = [...hosts, rec];
      return rec;
    },
    "hosts.update": async (id, patch) => {
      const i = hosts.findIndex((h) => h.id === String(id));
      const rec = { ...hosts[i], ...(patch as Partial<HostInput>) };
      hosts[i] = rec;
      return rec;
    },
    "creds.put": async () => undefined,
    "hosts.remove": async (id) => {
      hosts = hosts.filter((h) => h.id !== String(id));
    },
  });
  calls = b.calls;
}

async function mount(opts: { storage?: Record<string, string> } = {}): Promise<void> {
  installFake(opts.storage);
  const { initHostPanel } = await import("../../src/renderer/hosts");
  onConnect = vi.fn();
  panel = initHostPanel(onConnect as (h: HostRecord | null) => void);
  await waitFor(
    () => !!document.querySelector("#host-list .empty-hint, #host-list .host-item"),
    "first render",
  );
}

/* ---------- 查询 / 交互工具 ---------- */

const items = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("#host-list .host-item")];
const names = (): string[] => items().map((el) => el.querySelector(".name")!.textContent!);
const itemByName = (name: string): HTMLElement => {
  const el = items().find((x) => x.querySelector(".name")!.textContent === name);
  if (!el) throw new Error(`host item not found: ${name}`);
  return el;
};
const groupLabels = (): string[] =>
  [...document.querySelectorAll("#host-list .group-label")].map((el) => el.textContent ?? "");
const emptyHint = (): string | null => document.querySelector("#host-list .empty-hint")?.textContent ?? null;
const formVisible = (): boolean => document.getElementById("form-backdrop")!.classList.contains("visible");
const heading = (): string => document.getElementById("form-heading")!.textContent!;
const formError = (): string => document.getElementById("form-error")!.textContent!;
const setVal = (id: string, value: string): void => {
  (document.getElementById(id) as HTMLInputElement).value = value;
};
const getVal = (id: string): string => (document.getElementById(id) as HTMLInputElement).value;
const pickAuth = (value: "password" | "key" | "agent"): void => {
  const sel = document.getElementById("f-auth") as HTMLSelectElement;
  sel.value = value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
};
const submitForm = (): void => {
  document.getElementById("host-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
};
const search = (value: string): void => {
  const input = document.getElementById("host-search") as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const openNewForm = async (): Promise<void> => {
  ($("#btn-new-host") as HTMLButtonElement).click();
  await waitFor(formVisible, "form visible");
};
const openTagMenu = async (): Promise<HTMLElement> => {
  ($("#host-tags") as HTMLButtonElement).click();
  await waitFor(() => !!document.querySelector(".sort-menu"), "tag menu");
  return document.querySelector(".sort-menu") as HTMLElement;
};
const menuItem = (label: string): HTMLButtonElement =>
  [...(document.querySelector(".sort-menu") as HTMLElement).querySelectorAll<HTMLButtonElement>("button.sort-item")]
    .find((b) => b.textContent === label)!;
const confirmDialog = (): HTMLElement | null => document.querySelector(".discard-dlg");

beforeEach(() => {
  hosts = [];
  seq = 0;
  document.body.innerHTML = "";
  document.documentElement.lang = "en";
  localStorage.clear();
  vi.resetModules();
});

/* ================= 列表渲染 ================= */

describe("主机列表", () => {
  it("空列表显示引导空态(而不是空白面板)", async () => {
    await mount();
    expect(emptyHint()).toBe("No SSH hosts yet.Click ＋ to add one.");
    expect(items()).toHaveLength(0);
    expect(calls["hosts.list"]!.length).toBeGreaterThanOrEqual(1);
  });

  it("按分组渲染,分组名排序,组内按名称排序,副标题是 `类型, 用户名`", async () => {
    hosts = [
      HOST({ id: "h1", name: "beta", group: "prod", username: "alice" }),
      HOST({ id: "h2", name: "alpha", group: "prod", username: "root" }),
      HOST({ id: "h3", name: "gamma", group: undefined, username: "deploy" }),
    ];
    await mount();

    expect(groupLabels()).toEqual(["hosts", "prod"]);
    expect(names()).toEqual(["gamma", "alpha", "beta"]);
    expect(itemByName("alpha").querySelector(".small")!.textContent).toBe("ssh, root");
    expect(itemByName("gamma").querySelector(".small")!.textContent).toBe("ssh, deploy");
  });

  it("搜索按 名称/主机名/用户名 过滤;无结果显示提示;清空后恢复", async () => {
    hosts = [
      HOST({ id: "h1", name: "web-1", host: "10.0.0.1", username: "alice" }),
      HOST({ id: "h2", name: "db-1", host: "db.internal", username: "bob" }),
      HOST({ id: "h3", name: "cache-1", host: "10.0.0.3", username: "carol" }),
    ];
    await mount();
    expect(names()).toHaveLength(3);

    search("DB.INTERNAL");
    await waitFor(() => names().join() === "db-1", "filter by host");
    search("carol");
    await waitFor(() => names().join() === "cache-1", "filter by username");
    search("web");
    await waitFor(() => names().join() === "web-1", "filter by name");

    search("nope");
    await waitFor(() => emptyHint() !== null, "no-match hint");
    expect(emptyHint()).toBe("No hosts match your search.");

    search("");
    await waitFor(() => names().length === 3, "search cleared");
  });

  it("排序菜单:显示四种排序,当前项高亮,选择后重排并写 localStorage", async () => {
    hosts = [
      HOST({ id: "h1", name: "beta", createdAt: "2026-01-02T00:00:00.000Z" }),
      HOST({ id: "h2", name: "alpha", createdAt: "2026-01-03T00:00:00.000Z" }),
      HOST({ id: "h3", name: "gamma", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    await mount();
    expect(names()).toEqual(["alpha", "beta", "gamma"]);

    await openTagMenu();
    const menu = document.querySelector(".sort-menu") as HTMLElement;
    expect(menu.querySelector(".menu-cap")!.textContent).toBe("Sort by");
    expect([...menu.querySelectorAll("button.sort-item")].map((b) => b.textContent)).toEqual([
      "A-z", "Z-a", "Newest to oldest", "Oldest to newest",
    ]);
    expect(menu.querySelector("button.sort-item.on")!.textContent).toBe("A-z");

    menuItem("Z-a").click();
    await waitFor(() => names().join() === "gamma,beta,alpha", "za sort");
    expect(confirmDialog()).toBeNull();
    expect(document.querySelector(".sort-menu")).toBeNull();
    expect(localStorage.getItem("sshkit.hostSort")).toBe("za");

    await openTagMenu();
    menuItem("Newest to oldest").click();
    await waitFor(() => names().join() === "alpha,beta,gamma", "newest sort");

    await openTagMenu();
    menuItem("Oldest to newest").click();
    await waitFor(() => names().join() === "gamma,beta,alpha", "oldest sort");
  });

  it("排序偏好从 localStorage 恢复(重建面板后仍生效)", async () => {
    hosts = [HOST({ id: "h1", name: "alpha" }), HOST({ id: "h2", name: "beta" })];
    await mount({ storage: { "sshkit.hostSort": "za" } });
    expect(names()).toEqual(["beta", "alpha"]);
  });

  it("标签菜单:有标签时按标签过滤(无标签主机被排除);Clear filters 恢复", async () => {
    hosts = [
      HOST({ id: "h1", name: "alpha", tags: ["prod", "db"] }),
      HOST({ id: "h2", name: "beta", tags: ["dev"] }),
      HOST({ id: "h3", name: "gamma", tags: undefined }),
    ];
    await mount();

    const menu = await openTagMenu();
    expect([...menu.querySelectorAll(".tag-menu-item span")].map((s) => s.textContent)).toEqual(["db", "dev", "prod"]);

    const prodCb = [...menu.querySelectorAll<HTMLInputElement>(".tag-menu-item input")].find(
      (cb) => cb.parentElement!.textContent === "prod",
    )!;
    prodCb.checked = true;
    prodCb.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => names().join() === "alpha", "tag filter applied");
    expect(($("#host-tags") as HTMLElement).classList.contains("on")).toBe(true);

    /* Clear filters 只在"已有过滤条件"时出现:重新打开菜单才有 */
    ($("#host-tags") as HTMLButtonElement).click();
    await waitFor(
      () => [...document.querySelectorAll<HTMLButtonElement>(".sort-menu button.sort-item")]
        .some((b) => b.textContent === "Clear filters"),
      "clear button",
    );
    const clear = [...document.querySelectorAll<HTMLButtonElement>(".sort-menu button.sort-item")]
      .find((b) => b.textContent === "Clear filters")!;
    clear.click();
    await waitFor(() => names().length === 3, "tag filter cleared");
    expect(document.querySelector(".sort-menu")).toBeNull();
    expect(($("#host-tags") as HTMLElement).classList.contains("on")).toBe(false);
  });

  it("取消勾选标签会移除该过滤条件(不是只能靠 Clear filters)", async () => {
    hosts = [
      HOST({ id: "h1", name: "alpha", tags: ["prod"] }),
      HOST({ id: "h2", name: "beta", tags: ["dev"] }),
    ];
    await mount();

    let menu = await openTagMenu();
    const check = (label: string, checked: boolean): void => {
      const cb = [...menu.querySelectorAll<HTMLInputElement>(".tag-menu-item input")].find(
        (x) => x.parentElement!.textContent === label,
      )!;
      cb.checked = checked;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    };
    check("prod", true);
    await waitFor(() => names().join() === "alpha", "filtered");

    menu = await openTagMenu();
    expect([...menu.querySelectorAll<HTMLInputElement>(".tag-menu-item input")]
      .find((x) => x.parentElement!.textContent === "prod")!.checked).toBe(true);
    check("prod", false);
    await waitFor(() => names().length === 2, "filter removed");
    expect(($("#host-tags") as HTMLElement).classList.contains("on")).toBe(false);
  });

  it("没有主机带标签时,标签菜单显示 No tags yet(而不是空菜单)", async () => {
    hosts = [HOST({ id: "h1", name: "alpha", tags: undefined })];
    await mount();
    const menu = await openTagMenu();
    expect(menu.querySelector(".sort-item")!.textContent).toBe("No tags yet");
  });

  it("标签芯片只显示第一枚,其余收进 +N(悬停 title 列出全部)", async () => {
    hosts = [HOST({ id: "h1", name: "alpha", tags: ["prod", "db", "web"] })];
    await mount();

    const chips = itemByName("alpha").querySelectorAll(".tag-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe("prod✕");
    const more = itemByName("alpha").querySelector(".tag-more")!;
    expect(more.textContent).toBe("+2");
    expect(more.getAttribute("title")).toBe("prod, db, web");
  });

  it("点标签 ✕ 只移除该标签:更新主机并刷新(不触发整行连接)", async () => {
    hosts = [HOST({ id: "h1", name: "alpha", tags: ["prod", "db", "web"] })];
    await mount();

    (itemByName("alpha").querySelector(".tag-x") as HTMLButtonElement).click();
    await waitFor(() => calls["hosts.update"] !== undefined, "update called");
    const [id, patch] = calls["hosts.update"]!.at(-1)!;
    expect(id).toBe("h1");
    expect((patch as HostRecord).tags).toEqual(["db", "web"]);
    expect(onConnect).not.toHaveBeenCalled();

    await waitFor(() => itemByName("alpha").querySelector(".tag-more")?.textContent === "+1", "chip refreshed");
    expect(itemByName("alpha").querySelector(".tag-chip")!.textContent).toBe("db✕");
  });

  it("移除最后一个标签时把 tags 置为 undefined(不留空数组)", async () => {
    hosts = [HOST({ id: "h1", name: "alpha", tags: ["prod"] })];
    await mount();

    (itemByName("alpha").querySelector(".tag-x") as HTMLButtonElement).click();
    await waitFor(() => calls["hosts.update"] !== undefined, "update called");
    const [, patch] = calls["hosts.update"]!.at(-1)!;
    expect((patch as HostRecord).tags).toBeUndefined();
    await waitFor(() => itemByName("alpha").querySelector(".tag-chips") === null, "chips gone");
  });

  it("主机名里的 HTML 被转义成文本(不注入标记)", async () => {
    const hostile = `<img src=x onerror="globalThis.__hostPwned=1">&"'`;
    hosts = [HOST({ id: "h_xss", name: hostile })];
    await mount();

    const nameEl = itemByName(hostile).querySelector(".name") as HTMLElement;
    expect(nameEl.querySelector("img")).toBeNull();
    expect(nameEl.textContent).toBe(hostile);
    expect((globalThis as Record<string, unknown>).__hostPwned).toBeUndefined();
  });

  it("localStorage 里的标签配色损坏时降级为无色(不崩、不影响列表)", async () => {
    hosts = [HOST({ id: "h1", name: "alpha", tags: ["prod"] })];
    await mount({ storage: { "sshkit.tagColors": "{not-json" } });

    expect(names()).toEqual(["alpha"]);
    expect(itemByName("alpha").querySelectorAll(".tag-chip")).toHaveLength(1);
    expect(itemByName("alpha").querySelector(".tag-chip")!.getAttribute("style") ?? "").not.toContain("#");
  });

  it("标签配色:色点打开调色板,选色写入 localStorage 并作用到芯片;可清除", async () => {
    hosts = [HOST({ id: "h1", name: "alpha", tags: ["prod"] })];
    await mount();

    (itemByName("alpha").querySelector(".tag-dot") as HTMLButtonElement).click();
    await waitFor(() => !!document.querySelector(".tag-pal"), "palette");
    /* 再点一次色点:旧调色板先被收掉,页面里始终只有一块 */
    (itemByName("alpha").querySelector(".tag-dot") as HTMLButtonElement).click();
    await waitFor(() => document.querySelectorAll(".tag-pal").length === 1, "single palette");
    const swatches = [...document.querySelectorAll<HTMLButtonElement>(".tag-pal .tag-sw")];
    expect(swatches).toHaveLength(9); // 8 色 + 清除
    expect(swatches.at(-1)!.className).toContain("clear");
    expect(document.querySelector(".tag-pal .tag-sw.on")).toBeNull();

    swatches[0].click();
    await waitFor(() => localStorage.getItem("sshkit.tagColors") === JSON.stringify({ prod: "#e05252" }), "color saved");
    await waitFor(
      () => (itemByName("alpha").querySelector(".tag-chip")!.getAttribute("style") ?? "").includes("#e05252"),
      "chip colored",
    );
    /* jsdom 会把 6 位 hex 归一化成 rgb(),断言"色值生效"用归一化形态 */
    expect((itemByName("alpha").querySelector(".tag-dot") as HTMLElement).getAttribute("style"))
      .toMatch(/#e05252|rgb\(224,\s*82,\s*82\)/);

    /* 重新打开:当前色打勾 */
    (itemByName("alpha").querySelector(".tag-dot") as HTMLButtonElement).click();
    await waitFor(() => !!document.querySelector(".tag-pal .tag-sw.on"), "current color marked");
    (document.querySelector(".tag-pal .tag-sw.clear") as HTMLButtonElement).click();
    await waitFor(() => localStorage.getItem("sshkit.tagColors") === "{}", "color cleared");
    await waitFor(
      () => !(itemByName("alpha").querySelector(".tag-chip")!.getAttribute("style") ?? "").includes("#e05252"),
      "chip color removed",
    );
  });

  it("布局切换:grid 类与按钮字形同步,并写 localStorage", async () => {
    hosts = [HOST({ id: "h1", name: "alpha" })];
    await mount();
    const list = $("#host-list") as HTMLElement;
    const btn = $("#host-layout") as HTMLButtonElement;
    expect(list.classList.contains("grid")).toBe(false);
    expect(btn.textContent).toBe("▤");

    btn.click();
    expect(list.classList.contains("grid")).toBe(true);
    expect(btn.textContent).toBe("▦");
    expect(localStorage.getItem("sshkit.hostLayout")).toBe("grid");

    btn.click();
    expect(list.classList.contains("grid")).toBe(false);
    expect(btn.textContent).toBe("▤");
    expect(localStorage.getItem("sshkit.hostLayout")).toBe("list");
  });

  it("布局偏好从 localStorage 恢复", async () => {
    hosts = [HOST({ id: "h1", name: "alpha" })];
    await mount({ storage: { "sshkit.hostLayout": "grid" } });
    expect(($("#host-list") as HTMLElement).classList.contains("grid")).toBe(true);
    expect(($("#host-layout") as HTMLButtonElement).textContent).toBe("▦");
  });

  it("点排序/标签按钮后点页面其它地方会收起菜单", async () => {
    hosts = [HOST({ id: "h1", name: "alpha" })];
    await mount();
    await openTagMenu();
    await flush(3); // 监听是在 setTimeout(0) 里挂的
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".sort-menu")).toBeNull();
  });
});

/* ================= 表单 ================= */

describe("新建/编辑表单", () => {
  it("新建:标题/默认端口/默认认证;密码行显示、私钥行隐藏", async () => {
    await mount();
    await openNewForm();

    expect(heading()).toBe("New host");
    expect(getVal("f-port")).toBe("22");
    expect(getVal("f-auth")).toBe("password");
    expect(getVal("f-secret")).toBe("");
    expect(($("#f-key-row") as HTMLElement).style.display).toBe("none");
    expect(($("#f-secret-row") as HTMLElement).style.display).toBe("block");
    expect($("#f-secret-label").textContent).toBe("Password (saved in Keychain)");
    expect(formError()).toBe("");
  });

  it("切换认证方式联动字段可见性(私钥路径 / 密码 / SSH agent)", async () => {
    await mount();
    await openNewForm();

    pickAuth("key");
    expect(($("#f-key-row") as HTMLElement).style.display).toBe("block");
    expect(($("#f-secret-row") as HTMLElement).style.display).toBe("block");
    expect($("#f-secret-label").textContent).toBe("Key passphrase (optional, Keychain)");

    pickAuth("agent");
    expect(($("#f-key-row") as HTMLElement).style.display).toBe("none");
    expect(($("#f-secret-row") as HTMLElement).style.display).toBe("none");

    pickAuth("password");
    expect(($("#f-key-row") as HTMLElement).style.display).toBe("none");
    expect(($("#f-secret-row") as HTMLElement).style.display).toBe("block");
  });

  it("必填项:主机/用户名为 required;填齐后表单通过原生校验", async () => {
    await mount();
    await openNewForm();
    const form = document.getElementById("host-form") as HTMLFormElement;

    expect(form.checkValidity()).toBe(false);
    setVal("f-host", "10.0.0.5");
    setVal("f-username", "root");
    expect(form.checkValidity()).toBe(true);
  });

  it("新建密码主机:提交精确输入、写入钥匙串、关闭表单并刷新列表", async () => {
    await mount();
    await openNewForm();
    setVal("f-name", "web-1");
    setVal("f-group", "prod");
    setVal("f-tags", " prod , db ,, ");
    setVal("f-host", "10.0.0.9");
    setVal("f-port", "2222");
    setVal("f-username", "deploy");
    setVal("f-secret", "s3cret");
    submitForm();

    await waitFor(() => !formVisible(), "form closed");
    const input = calls["hosts.create"]!.at(-1)![0] as HostInput;
    expect(input).toMatchObject({
      name: "web-1",
      group: "prod",
      tags: ["prod", "db"],
      host: "10.0.0.9",
      port: 2222,
      username: "deploy",
      authType: "password",
      keyPath: undefined,
    });
    /* 凭据只走 creds.put(渲染层永远拿不到已保存密码) */
    expect(calls["creds.put"]!.at(-1)).toEqual([`h_${seq}`, { password: "s3cret" }]);
    await waitFor(() => names().includes("web-1"), "new host listed");
    expect(calls["hosts.create"]).toHaveLength(1);
  });

  it("新建私钥主机:keyPath 进入主机输入,口令以 passphrase 写入钥匙串", async () => {
    await mount();
    await openNewForm();
    setVal("f-name", "key-host");
    setVal("f-host", "10.0.0.10");
    setVal("f-username", "root");
    pickAuth("key");
    setVal("f-keypath", "~/.ssh/id_ed25519");
    setVal("f-secret", "passphrase-1");
    submitForm();

    await waitFor(() => !formVisible(), "form closed");
    const input = calls["hosts.create"]!.at(-1)![0] as HostInput;
    expect(input).toMatchObject({ authType: "key", keyPath: "~/.ssh/id_ed25519" });
    expect(calls["creds.put"]!.at(-1)).toEqual([`h_${seq}`, { passphrase: "passphrase-1" }]);
  });

  it("SSH agent 认证不写任何 secret(即使隐藏字段里残留了值)", async () => {
    await mount();
    await openNewForm();
    setVal("f-name", "agent-host");
    setVal("f-host", "10.0.0.11");
    setVal("f-username", "root");
    pickAuth("agent");
    setVal("f-keypath", "/tmp/unused-key");
    setVal("f-secret", "should-not-be-saved");
    submitForm();

    await waitFor(() => !formVisible(), "form closed");
    const input = calls["hosts.create"]!.at(-1)![0] as HostInput;
    expect(input).toMatchObject({ authType: "agent", keyPath: undefined });
    expect(calls["creds.put"]).toBeUndefined();
  });

  it("保存失败:错误显示在表单里(去掉 IPC 前缀),表单不关闭", async () => {
    await mount();
    installFakeForError(new Error("Error invoking remote method 'hosts:create', EEXIST: host already exists"));
    await openNewForm();
    setVal("f-name", "dup");
    setVal("f-host", "10.0.0.12");
    setVal("f-username", "root");
    submitForm();

    await waitFor(() => formError() !== "", "error shown");
    expect(formError()).toBe("EEXIST: host already exists");
    expect(formVisible()).toBe(true);
  });

  it("保存失败:非 Error 的拒绝值(字符串)也能显示出来,而不是 undefined", async () => {
    await mount();
    installFakeForError("disk quota exceeded");
    await openNewForm();
    setVal("f-host", "10.0.0.13");
    setVal("f-username", "root");
    submitForm();

    await waitFor(() => formError() !== "", "error shown");
    expect(formError()).toBe("disk quota exceeded");
  });

  it("端口留空提交时按默认 22 保存(不是 0 / NaN)", async () => {
    await mount();
    await openNewForm();
    setVal("f-name", "no-port");
    setVal("f-host", "10.0.0.14");
    setVal("f-username", "root");
    setVal("f-port", "");
    submitForm();

    await waitFor(() => !formVisible(), "form closed");
    expect((calls["hosts.create"]!.at(-1)![0] as HostInput).port).toBe(22);
  });

  it("编辑:字段预填(含分组/标签/私钥路径),标题变 Edit <name>,保存走 update 而不是 create", async () => {
    hosts = [HOST({ id: "h_edit", name: "alpha", group: "prod", tags: ["prod", "db"],
      authType: "key", keyPath: "~/.ssh/id_rsa", port: 2200 })];
    await mount();

    (itemByName("alpha").querySelector("[data-act=edit]") as HTMLButtonElement).click();
    await waitFor(formVisible, "form visible");
    expect(heading()).toBe("Edit alpha");
    expect(getVal("f-name")).toBe("alpha");
    expect(getVal("f-group")).toBe("prod");
    expect(getVal("f-tags")).toBe("prod, db");
    expect(getVal("f-port")).toBe("2200");
    expect(getVal("f-auth")).toBe("key");
    expect(getVal("f-keypath")).toBe("~/.ssh/id_rsa");
    expect(($("#f-key-row") as HTMLElement).style.display).toBe("block");
    expect(onConnect).not.toHaveBeenCalled();

    setVal("f-name", "alpha-renamed");
    submitForm();
    await waitFor(() => !formVisible(), "form closed");
    expect(calls["hosts.update"]!.at(-1)![0]).toBe("h_edit");
    expect(calls["hosts.update"]!.at(-1)![1]).toMatchObject({ name: "alpha-renamed", authType: "key",
      keyPath: "~/.ssh/id_rsa", port: 2200, tags: ["prod", "db"] });
    expect(calls["hosts.create"]).toBeUndefined();
    await waitFor(() => names().includes("alpha-renamed"), "list refreshed");
  });

  it("打开表单时把已有标签喂给 datalist 自动补全(无标签主机不参与)", async () => {
    hosts = [
      HOST({ id: "h1", name: "a", tags: ["prod"] }),
      HOST({ id: "h2", name: "b", tags: ["db", "prod"] }),
      HOST({ id: "h3", name: "c", tags: undefined }),
    ];
    await mount();
    await openNewForm();
    await waitFor(() => !!document.getElementById("tag-suggest"), "datalist");

    const options = [...document.querySelectorAll<HTMLOptionElement>("#tag-suggest option")].map((o) => o.value);
    expect(options).toEqual(["db", "prod"]);
    expect(getVal("f-tags")).toBe("");
    expect((document.getElementById("f-tags") as HTMLInputElement).getAttribute("list")).toBe("tag-suggest");
  });

  it("点主机卡片触发 onConnect(host);点编辑/删除按钮不会顺带发起连接", async () => {
    hosts = [HOST({ id: "h_click", name: "alpha" })];
    await mount();

    itemByName("alpha").querySelector(".hcol")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect.mock.calls[0][0]).toMatchObject({ id: "h_click", name: "alpha" });

    (itemByName("alpha").querySelector("[data-act=edit]") as HTMLButtonElement).click();
    await waitFor(formVisible, "edit form");
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});

/* ================= 确认弹窗 ================= */

describe("确认弹窗", () => {
  it("删除主机:先弹应用内确认框;取消则主机仍在且不调 remove", async () => {
    hosts = [HOST({ id: "h_del", name: "alpha" })];
    await mount();

    (itemByName("alpha").querySelector("[data-act=del]") as HTMLButtonElement).click();
    await waitFor(() => !!confirmDialog(), "delete dialog");
    expect(confirmDialog()!.querySelector(".dd-head span")!.textContent).toBe("Delete host?");
    expect(confirmDialog()!.querySelector(".dd-body p")!.textContent).toContain('Delete "alpha"');
    expect(confirmDialog()!.querySelector(".dd-ok")!.textContent).toBe("Delete");
    expect(confirmDialog()!.querySelector(".dd-ok")!.className).toContain("danger");

    (confirmDialog()!.querySelector(".dd-x") as HTMLButtonElement).click();
    await flush(4);
    expect(confirmDialog()).toBeNull();
    expect(calls["hosts.remove"]).toBeUndefined();
    expect(items()).toHaveLength(1);

    /* 点遮罩(弹窗外的空白)视为取消 */
    (itemByName("alpha").querySelector("[data-act=del]") as HTMLButtonElement).click();
    await waitFor(() => !!confirmDialog(), "delete dialog again");
    confirmDialog()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush(4);
    expect(confirmDialog()).toBeNull();
    expect(calls["hosts.remove"]).toBeUndefined();
    expect(items()).toHaveLength(1);
  });

  it("连续触发确认框时只保留最新一个(不叠两层)", async () => {
    hosts = [HOST({ id: "h_a", name: "alpha" }), HOST({ id: "h_b", name: "beta" })];
    await mount();

    (itemByName("alpha").querySelector("[data-act=del]") as HTMLButtonElement).click();
    await waitFor(() => !!confirmDialog(), "first dialog");
    (itemByName("beta").querySelector("[data-act=del]") as HTMLButtonElement).click();
    await waitFor(
      () => confirmDialog()!.querySelector(".dd-body p")!.textContent!.includes('Delete "beta"'),
      "second dialog replaces",
    );
    expect(document.querySelectorAll(".discard-dlg")).toHaveLength(1);
    (confirmDialog()!.querySelector(".dd-x") as HTMLButtonElement).click();
    await flush(4);
    expect(confirmDialog()).toBeNull();
    expect(calls["hosts.remove"]).toBeUndefined();
  });

  it("删除主机:确认后调 remove(id) 并刷新掉该行", async () => {
    hosts = [HOST({ id: "h_del", name: "alpha" }), HOST({ id: "h_keep", name: "beta" })];
    await mount();

    (itemByName("alpha").querySelector("[data-act=del]") as HTMLButtonElement).click();
    await waitFor(() => !!confirmDialog(), "delete dialog");
    (confirmDialog()!.querySelector(".dd-ok") as HTMLButtonElement).click();

    await waitFor(() => items().length === 1, "row removed");
    expect(calls["hosts.remove"]!.at(-1)).toEqual(["h_del"]);
    expect(names()).toEqual(["beta"]);
  });

  it("放弃修改:有输入时取消表单会先确认;✕ 只是关弹窗,Discard changes 才关表单", async () => {
    await mount();
    await openNewForm();
    setVal("f-name", "half-typed");
    ($("#btn-cancel") as HTMLButtonElement).click();
    await waitFor(() => !!confirmDialog(), "discard dialog");

    expect(confirmDialog()!.querySelector(".dd-head span")!.textContent).toBe("Do you want to discard changes?");
    expect(confirmDialog()!.querySelector(".dd-body p")!.textContent).toBe(
      "Not all required fields are filled. Do you want to finish editing and discard all changes?",
    );
    expect(confirmDialog()!.querySelector(".dd-ok")!.textContent).toBe("Discard changes");

    (confirmDialog()!.querySelector(".dd-x") as HTMLButtonElement).click();
    await flush(4);
    expect(confirmDialog()).toBeNull();
    expect(formVisible()).toBe(true); // 弹窗关掉不等于放弃编辑

    /* 点遮罩同样只是关弹窗,不放弃编辑 */
    ($("#btn-cancel") as HTMLButtonElement).click();
    await waitFor(() => !!confirmDialog(), "discard dialog via backdrop");
    confirmDialog()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush(4);
    expect(confirmDialog()).toBeNull();
    expect(formVisible()).toBe(true);

    ($("#btn-cancel") as HTMLButtonElement).click();
    await waitFor(() => !!confirmDialog(), "discard dialog again");
    (confirmDialog()!.querySelector(".dd-ok") as HTMLButtonElement).click();
    await waitFor(() => !formVisible(), "form closed");
    expect(calls["hosts.create"]).toBeUndefined();
  });

  it("点表单遮罩关闭也走同一套「放弃修改」确认", async () => {
    await mount();
    await openNewForm();
    setVal("f-host", "10.0.0.99");
    const backdrop = $("#form-backdrop") as HTMLElement;
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => !!confirmDialog(), "discard dialog");
    (confirmDialog()!.querySelector(".dd-ok") as HTMLButtonElement).click();
    await waitFor(() => !formVisible(), "form closed");
  });
});

/* ================= 活动态 ================= */

describe("markActiveHost", () => {
  it("只给匹配的主机卡片挂 active;传 null 时全部清掉", async () => {
    hosts = [HOST({ id: "h1", name: "alpha" }), HOST({ id: "h2", name: "beta" })];
    await mount();
    const { markActiveHost } = await import("../../src/renderer/hosts");

    markActiveHost("h2");
    expect(itemByName("beta").classList.contains("active")).toBe(true);
    expect(itemByName("alpha").classList.contains("active")).toBe(false);

    markActiveHost(null);
    expect(items().some((el) => el.classList.contains("active"))).toBe(false);
  });
});

/* ================= 回归:放弃修改的"有改动"判定 ================= */

/** 保存失败用例需要一个会抛错的桥;单独装一次,避免污染其它用例 */
function installFakeForError(thrown: unknown): void {
  const api = (window as unknown as { sshkit: AnyBridge }).sshkit;
  api.hosts.create = async () => { throw thrown; };
}

describe("回归:放弃修改的「有改动」判定", () => {
  it("刚打开、没有任何输入的新建表单,点取消不弹「放弃修改」", async () => {
    /*
     * 回归背景:该弹窗语义是「关闭**有改动**的表单时弹出」,但旧实现按"任一字段非空"判定,
     * 而 openForm() 预填了端口 22 → 什么都没输入点取消也会被问"放弃修改"。现按"打开时快照"
     * 对比。期望:没改过任何字段时 Cancel 直接关闭;有改动时才弹确认。
     */
    await mount();
    await openNewForm();
    ($("#btn-cancel") as HTMLButtonElement).click();
    await flush(6);

    expect(confirmDialog()).toBeNull();
    expect(formVisible()).toBe(false);
  });

  it("只改了用户名也算有改动:取消时必须确认,不能静默丢弃输入", async () => {
    /*
     * 回归:formDirty 的快照字段表曾写成 f-user / f-pass / f-key(真实 id 是
     * f-username / f-secret / f-keypath),导致只改这几项时判定为"没改动"——
     * 点取消直接关表单,用户输入静默丢失。
     */
    await mount();
    await openNewForm();
    setVal("f-username", "root");
    ($("#btn-cancel") as HTMLButtonElement).click();
    await waitFor(() => !!confirmDialog(), "discard dialog for username-only change");

    /* 关掉确认框后输入必须还在(没确认放弃就不该丢) */
    (confirmDialog()!.querySelector(".dd-x") as HTMLButtonElement).click();
    await flush(4);
    expect(confirmDialog()).toBeNull();
    expect(formVisible()).toBe(true);
    expect(getVal("f-username")).toBe("root");
  });
});

/* ================= 覆盖率补强:时间戳缺失 / 表单容器缺项 / 弹窗替换 ================= */

describe("列表排序 · 缺失 createdAt", () => {
  it("createdAt 缺失的主机按空串参与 Newest/Oldest 排序(不抛错)", async () => {
    hosts = [
      HOST({ id: "h1", name: "dated", createdAt: "2026-02-01T00:00:00.000Z" }),
      HOST({ id: "h2", name: "nodate", createdAt: undefined as unknown as string }),
    ];
    await mount();
    await openTagMenu();
    menuItem("Newest to oldest").click();
    await waitFor(() => names().join() === "dated,nodate", "newest with missing createdAt");

    await openTagMenu();
    menuItem("Oldest to newest").click();
    await waitFor(() => names().join() === "nodate,dated", "oldest with missing createdAt");

    /* 换个数组顺序再排一次:比较器的两个参数分别轮到"缺失值"时才覆盖 (x.createdAt ?? "") 的两侧 */
    hosts = [
      HOST({ id: "h2", name: "nodate", createdAt: undefined as unknown as string }),
      HOST({ id: "h1", name: "dated", createdAt: "2026-02-01T00:00:00.000Z" }),
    ];
    search("");
    await flush(6);
    await openTagMenu();
    menuItem("Newest to oldest").click();
    await waitFor(() => names().join() === "dated,nodate", "newest reversed");
    await openTagMenu();
    menuItem("Oldest to newest").click();
    await waitFor(() => names().join() === "nodate,dated", "oldest reversed");
  });
});

describe("表单快照 · 字段容器缺项", () => {
  it("某字段不在 DOM 时按空值快照:未改动的表单取消时不弹放弃确认", async () => {
    await mount();
    await openNewForm();
    document.getElementById("f-group")!.remove(); // 新建时 f-group 本来就是空的
    ($("#btn-cancel") as HTMLButtonElement).click();
    await flush(6);
    expect(confirmDialog()).toBeNull();
    expect(formVisible()).toBe(false);
  });

  it("放弃确认框重复打开时只保留一个(旧框先移除)", async () => {
    await mount();
    await openNewForm();
    setVal("f-name", "dirty");
    ($("#btn-cancel") as HTMLButtonElement).click();
    await waitFor(() => !!confirmDialog(), "first discard dialog");
    ($("#btn-cancel") as HTMLButtonElement).click(); // 再点一次:openDiscardDialog 先清旧框
    await flush(4);
    expect(document.querySelectorAll(".discard-dlg").length).toBe(1);
    expect(confirmDialog()!.querySelector(".dd-head span")!.textContent).toBe("Do you want to discard changes?");
  });

  it("标签自动补全:datalist 收集全部主机的标签并挂到 f-tags", async () => {
    hosts = [
      HOST({ id: "h1", name: "a", tags: ["prod", "db"] }),
      HOST({ id: "h2", name: "b", tags: ["dev", "prod"] }),
    ];
    await mount();
    await openNewForm();
    await waitFor(() => !!document.getElementById("tag-suggest"), "tag datalist");
    const opts = [...document.querySelectorAll<HTMLOptionElement>("#tag-suggest option")].map((o) => o.value);
    expect(opts).toEqual(["db", "dev", "prod"]);
    expect(document.getElementById("f-tags")!.getAttribute("list")).toBe("tag-suggest");
  });
});

/* ---------- 回归:空态文案跟着语言走 ---------- */
describe("空态文案随语言切换(回归)", () => {
  it("空态用 i18n 表的值,而不是写死的英文", async () => {
    /* 背景:boot 里主机面板比语言加载更早渲染,空态文案被定死在默认英文,
       切语言后也不重建 —— 中文界面里冒出 "No SSH hosts yet."(对比原版时发现)。
       修法 = 语言加载提前到面板渲染之前 + setLanguage 里重建面板;
       这里锁住文案的来源(表格值),真实渲染由 app 手工验证 + e2e 覆盖。 */
    setLocale("zh");
    expect(tr("hosts.emptyTitle")).toBe("还没有 SSH 主机。");
    expect(tr("hosts.emptyHint")).toBe("点右上角 ＋ 添加一台。");
    setLocale("en");
    expect(tr("hosts.emptyTitle")).toBe("No SSH hosts yet.");
    expect(tr("hosts.emptyHint")).toBe("Click ＋ to add one.");
    setLocale("zh");
  });
});
