// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, installBridge, loadRendererDom, type BridgeCalls } from "../helpers/renderer";
import type { ForwardRule, ForwardStatus } from "../../src/shared/forward";

/**
 * fwd.ts 的行为测试:转发规则列表(三种类型 / 四种状态 / 起停 / 删除 / 实时状态推送)
 * + 四步向导(类型选择 → 端口绑定 → 中间主机 → 目的主机 → 保存;编辑复用同一向导)。
 *
 * 说明:共享 helper 的假桥里 `fwd.onStatus` 调用被记录但 override 不生效,而本视图
 * 必须在创建时订阅实时状态;因此按 preload 真实签名(返回退订函数)在实例上补齐。
 */

type AnyBridge = Record<string, any>;
interface HostLite { id: string; name: string; username: string; host: string; authType: string }

let rules: ForwardRule[];
let statuses: Map<string, ForwardStatus>;
let hosts: HostLite[];
let calls: BridgeCalls;
let saved: ForwardRule[];
let statusCb: ((s: ForwardStatus) => void) | null;

const RULE = (over: Partial<ForwardRule>): ForwardRule => ({
  id: "r1",
  hostId: "h1",
  kind: "local",
  bindAddress: "0.0.0.0",
  port: 18080,
  destinationAddress: "127.0.0.1",
  destinationPort: 5432,
  ...over,
});

const STATUS = (id: string, over: Partial<ForwardStatus> = {}): ForwardStatus => ({
  id, state: "stopped", active: 0, total: 0, ...over,
});

async function waitFor(cond: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (cond()) return;
    await flush(2);
  }
  throw new Error(`waitFor timeout: ${label}`);
}

function installFake(): AnyBridge {
  loadRendererDom();
  const b = installBridge({
    "hosts.list": async () => hosts,
    "fwd.rules": async () => rules.map((r) => ({ ...r })),
    "fwd.statuses": async () => [...statuses.values()].map((s) => ({ ...s })),
    "fwd.save": async (rule) => {
      const r = rule as ForwardRule;
      saved.push(r);
      rules = [...rules.filter((x) => x.id !== r.id), r];
      return r;
    },
    "fwd.start": async (rule) => {
      const st = STATUS((rule as ForwardRule).id, { state: "starting" });
      statuses.set(st.id, st);
      return st;
    },
    "fwd.stop": async (id) => {
      const st = STATUS(String(id), { state: "stopped" });
      statuses.set(st.id, st);
      return st;
    },
  });
  calls = b.calls;
  const api = (window as unknown as { sshkit: AnyBridge }).sshkit;
  /* 共享 helper 目前把 preload 的 fwd.remove 写成了 fwd.delete、且 onStatus 不读 override;
     按 preload 真实签名在实例上补齐(仍是"忠实替身":返回规则列表 / 退订函数)。 */
  const record = (name: string, impl: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return impl(...args);
  };
  api.fwd.remove = record("fwd.remove", async (id) => {
    rules = rules.filter((r) => r.id !== String(id));
    return rules.map((r) => ({ ...r }));
  });
  api.fwd.onStatus = (cb: (s: ForwardStatus) => void) => {
    statusCb = cb;
    return () => { statusCb = null; };
  };
  return api;
}

async function mount(): Promise<HTMLElement> {
  installFake();
  const { createFwdView } = await import("../../src/renderer/fwd");
  const view = createFwdView();
  document.body.append(view.el);
  view.onShow();
  await waitFor(() => !!view.el.querySelector(".fwd-list, .fwd-empty"), "first render");
  return view.el;
}

/* ---------- 查询工具 ---------- */

const rowEls = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".fwd-row")];
const row = (id: string): HTMLElement => {
  const el = rowEls().find((r) => {
    const btn = r.querySelector<HTMLElement>("[data-rule-id]");
    return btn?.dataset.ruleId === id;
  });
  if (!el) throw new Error(`forward row not found: ${id}`);
  return el;
};
const btn = (el: HTMLElement, index: 0 | 1 | 2): HTMLButtonElement =>
  el.querySelectorAll("button")[index] as HTMLButtonElement;
const stateText = (id: string): string => row(id).querySelector(".fwd-state")!.textContent!;
const toggleText = (id: string): string => btn(row(id), 1).textContent!;
const subText = (id: string): string => row(id).querySelector(".fwd-sub")!.textContent!;
const titleText = (id: string): string => row(id).querySelector(".fwd-title")!.textContent!;

const wiz = (): HTMLElement | null => document.querySelector(".fwd-wiz");
const wizRoot = (): HTMLElement => {
  const el = wiz();
  if (!el) throw new Error("wizard not open");
  return el;
};
const crumb = (): string => wizRoot().querySelector(".crumb")!.textContent!;
const wizTitle = (): string => wizRoot().querySelector(".fwd-wiz-body h3")!.textContent!;
const hints = (): string[] =>
  [...wizRoot().querySelectorAll(".fwd-wiz-body .fwd-hint")].map((p) => p.textContent ?? "");
const caps = (): string[] =>
  [...wizRoot().querySelectorAll(".fwd-field .cap")].map((s) => s.textContent ?? "");
const next = (): HTMLButtonElement => wizRoot().querySelector(".wiz-next") as HTMLButtonElement;
const back = (): HTMLButtonElement => wizRoot().querySelector(".wiz-back") as HTMLButtonElement;
const skip = (): HTMLButtonElement => wizRoot().querySelector(".wiz-skip") as HTMLButtonElement;
const kindBtn = (label: string): HTMLButtonElement =>
  [...wizRoot().querySelectorAll<HTMLButtonElement>(".fwd-kind")].find((b) => b.textContent?.includes(label))!;
const field = (slug: string): HTMLInputElement =>
  wizRoot().querySelector(`.fwd-wiz-body input[data-f="${slug}"]`) as HTMLInputElement;
const typeField = (slug: string, value: string): void => {
  const input = field(slug);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const choseKind = (label: string): void => {
  kindBtn(label).click();
  next().click(); // 第一步 → 第二步
};
const pickHost = (name: string): void => {
  (wizRoot().querySelector(".fwd-wiz-body button.btn") as HTMLButtonElement).click();
  const menu = wizRoot().querySelector(".fwd-hostmenu") as HTMLElement;
  const item = [...menu.querySelectorAll<HTMLElement>(".fwd-hostitem")].find(
    (b) => b.querySelector(".hn")!.textContent === name,
  )!;
  item.click();
};

function baseFakeData(): void {
  rules = [
    RULE({ id: "r-local", label: "Database tunnel", hostId: "h1", port: 13306,
      destinationAddress: "10.0.0.5", destinationPort: 3306 }),
  ];
  statuses = new Map();
  hosts = [
    { id: "h1", name: "node-1", username: "root", host: "192.0.2.10", authType: "password" },
    { id: "h2", name: "node-2", username: "root", host: "192.0.2.11", authType: "key" },
  ];
  saved = [];
  statusCb = null;
}

beforeEach(() => {
  baseFakeData();
  document.body.innerHTML = "";
  document.documentElement.lang = "en";
  localStorage.clear();
  vi.resetModules();
});

/* ================= 列表 ================= */

describe("转发规则列表", () => {
  it("没有规则时显示原版空态文案;首次展示会拉主机/规则/状态", async () => {
    rules = [];
    statuses = new Map();
    const el = await mount();

    expect(el.querySelector(".fwd-empty h3")!.textContent).toBe("Set up port forwarding");
    expect(el.querySelector(".fwd-empty p")!.textContent).toBe(
      "Save port forwarding to access databases, web apps, and other services.",
    );
    expect(el.querySelector(".fwd-list")).toBeNull();
    expect(calls["hosts.list"]).toHaveLength(1);
    expect(calls["fwd.rules"]).toHaveLength(1);
    expect(calls["fwd.statuses"]).toHaveLength(1);
  });

  it("三种类型渲染徽标/标题/副标题(含实际绑定端口与主机名回退)", async () => {
    rules = [
      RULE({ id: "r-local", label: "Database tunnel", hostId: "h1", kind: "local",
        bindAddress: "127.0.0.1", port: 13306, destinationAddress: "10.0.0.5", destinationPort: 3306 }),
      RULE({ id: "r-remote", hostId: "h2", kind: "remote", bindAddress: "0.0.0.0",
        port: 2222, destinationAddress: "127.0.0.1", destinationPort: 22 }),
      RULE({ id: "r-dyn", label: "SOCKS proxy", hostId: "h-missing", kind: "dynamic",
        bindAddress: "127.0.0.1", port: 1080, destinationAddress: "", destinationPort: 0 }),
    ];
    statuses = new Map([
      ["r-local", STATUS("r-local", { state: "running", active: 2, total: 7, boundPort: 13307 })],
      ["r-remote", STATUS("r-remote", { state: "stopped" })],
    ]);
    await mount();

    expect(rowEls()).toHaveLength(3);
    /* local:徽标 L、用户自定义名、副标题用 status.boundPort(端口 0 时系统分配) */
    expect(row("r-local").querySelector(".fwd-badge")!.textContent).toBe("L");
    expect(row("r-local").querySelector(".fwd-badge")!.className).toBe("fwd-badge local");
    expect(titleText("r-local")).toBe("Database tunnel");
    expect(subText("r-local")).toBe("127.0.0.1:13307 → 10.0.0.5:3306 via node-1");
    /* remote:没有自定义名 → 类型+端口;绑定的远端端口未由状态回填时回退规则端口 */
    expect(row("r-remote").querySelector(".fwd-badge")!.textContent).toBe("R");
    expect(titleText("r-remote")).toBe("Remote 2222");
    expect(subText("r-remote")).toBe("0.0.0.0:2222 → 127.0.0.1:22 via node-2");
    /* dynamic:副标题是 SOCKS5 形态;主机查不到时回退 hostId(不渲染成 undefined) */
    expect(row("r-dyn").querySelector(".fwd-badge")!.textContent).toBe("D");
    expect(titleText("r-dyn")).toBe("SOCKS proxy");
    expect(subText("r-dyn")).toBe("SOCKS5 127.0.0.1:1080 via h-missing");
  });

  it("四种状态各有可读文案;运行/启动中禁用编辑,停止/错误可编辑", async () => {
    rules = [
      RULE({ id: "run", label: "a" }),
      RULE({ id: "start", label: "b" }),
      RULE({ id: "stop", label: "c" }),
      RULE({ id: "err", label: "d" }),
    ];
    statuses = new Map([
      ["run", STATUS("run", { state: "running", active: 3 })],
      ["start", STATUS("start", { state: "starting" })],
      ["stop", STATUS("stop", { state: "stopped" })],
      ["err", STATUS("err", { state: "error", error: "EADDRINUSE" })],
    ]);
    await mount();

    expect(stateText("run")).toBe("running · 3 conn");
    expect(stateText("start")).toBe("starting");
    expect(stateText("stop")).toBe("stopped");
    expect(stateText("err")).toBe("error: EADDRINUSE");

    expect(btn(row("run"), 0).disabled).toBe(true);
    expect(btn(row("start"), 0).disabled).toBe(true);
    expect(btn(row("stop"), 0).disabled).toBe(false);
    expect(btn(row("err"), 0).disabled).toBe(false);
    expect(btn(row("run"), 0).title).toBe("Stop the rule before editing");
    expect(btn(row("stop"), 0).title).toBe("Edit rule");

    expect(toggleText("run")).toBe("Stop");
    expect(toggleText("start")).toBe("Stop");
    expect(toggleText("stop")).toBe("Start");
    expect(toggleText("err")).toBe("Start");
  });

  it("停止态点 Start → 调 fwd.start(整条规则)并刷新为启动中", async () => {
    rules = [RULE({ id: "r1" })];
    statuses = new Map([["r1", STATUS("r1")]]);
    await mount();
    expect(toggleText("r1")).toBe("Start");

    btn(row("r1"), 1).click();
    await waitFor(() => toggleText("r1") === "Stop", "started");

    expect(calls["fwd.start"]!.at(-1)).toEqual([rules[0]]);
    expect(stateText("r1")).toBe("starting");
    /* 起停之后必须重新拉状态,不能靠本地猜 */
    expect(calls["fwd.statuses"]!.length).toBeGreaterThanOrEqual(2);
  });

  it("运行中点 Stop → 调 fwd.stop(只传 id)并刷新为 stopped", async () => {
    rules = [RULE({ id: "r1" })];
    statuses = new Map([["r1", STATUS("r1", { state: "running", active: 1 })]]);
    await mount();
    expect(toggleText("r1")).toBe("Stop");

    btn(row("r1"), 1).click();
    await waitFor(() => toggleText("r1") === "Start", "stopped");
    expect(calls["fwd.stop"]!.at(-1)).toEqual(["r1"]);
    expect(stateText("r1")).toBe("stopped");
  });

  it("删除:调 fwd.remove(id),用返回的规则列表重绘", async () => {
    rules = [RULE({ id: "r1", label: "keep" }), RULE({ id: "r2", label: "drop" })];
    statuses = new Map();
    await mount();
    expect(rowEls()).toHaveLength(2);

    btn(row("r2"), 2).click();
    await waitFor(() => rowEls().length === 1, "deleted");
    expect(calls["fwd.remove"]!.at(-1)).toEqual(["r2"]);
    expect(titleText("r1")).toBe("keep");
  });

  it("实时状态推送直接更新该行,不再整表重拉", async () => {
    rules = [RULE({ id: "r1", label: "live" })];
    statuses = new Map([["r1", STATUS("r1", { state: "stopped" })]]);
    await mount();
    expect(statusCb).toBeTruthy();
    const ruleCalls = calls["fwd.rules"]!.length;
    const statusCalls = calls["fwd.statuses"]!.length;

    statusCb!(STATUS("r1", { state: "running", active: 4, total: 9 }));
    await waitFor(() => toggleText("r1") === "Stop", "live running");
    expect(stateText("r1")).toBe("running · 4 conn");

    statusCb!(STATUS("r1", { state: "error", error: "ECONNRESET" }));
    await waitFor(() => stateText("r1") === "error: ECONNRESET", "live error");
    expect(toggleText("r1")).toBe("Start");

    expect(calls["fwd.rules"]!.length).toBe(ruleCalls);
    expect(calls["fwd.statuses"]!.length).toBe(statusCalls);
  });
});

/* ================= 向导 ================= */

describe("新建转发向导", () => {
  it("第一步:标题/三种类型/说明;默认 Local;Back 在第一步禁用", async () => {
    await mount();
    (document.querySelector(".fwd-new-main") as HTMLButtonElement).click();

    expect(wiz()).toBeTruthy();
    expect(crumb()).toBe("Port Forwarding");
    expect(wizTitle()).toBe("New Port Forwarding");
    expect(hints()[0]).toBe("Select the port forwarding type:");
    expect([...wizRoot().querySelectorAll(".fwd-kind .n")].map((n) => n.textContent)).toEqual([
      "Local", "Remote", "Dynamic",
    ]);
    expect(wizRoot().querySelector(".fwd-kind.on .n")!.textContent).toBe("Local");
    expect(hints().at(-1)).toBe(
      "Local forwarding lets you access a remote server's listening port as though it were local.",
    );
    expect(back().disabled).toBe(true);
    expect(next().textContent).toBe("Continue");
  });

  it("切换类型会更新说明文案(不是只高亮按钮)", async () => {
    await mount();
    (document.querySelector(".fwd-new-caret") as HTMLButtonElement).click();

    kindBtn("Remote").click();
    expect(wizRoot().querySelector(".fwd-kind.on .n")!.textContent).toBe("Remote");
    expect(hints().at(-1)).toContain("opens a port on the remote machine");

    kindBtn("Dynamic").click();
    expect(wizRoot().querySelector(".fwd-kind.on .n")!.textContent).toBe("Dynamic");
    expect(hints().at(-1)).toContain("turns sshkit into a SOCKS proxy server");
  });

  it("第二步(Local):字段与默认值;必填端口为空时 Continue 不前进", async () => {
    await mount();
    (document.querySelector(".fwd-new-main") as HTMLButtonElement).click();
    next().click();

    expect(crumb()).toBe("Local Rule");
    expect(wizTitle()).toBe("Local Port Forwarding");
    expect(hints().at(-1)).toContain("This port will be open on the local (current) machine");
    expect(caps()).toEqual(["Local port number *", "Bind address"]);
    expect(field("port").value).toBe("");
    expect(field("bind").value).toBe("0.0.0.0");

    const titleBefore = wizTitle();
    next().click();
    expect(wizTitle()).toBe(titleBefore); // 仍在第二步
    typeField("port", "abc"); // 非数字 → Number(...)||0 → 0,仍不满足必填
    next().click();
    expect(wizTitle()).toBe(titleBefore);
    expect(calls["fwd.save"]).toBeUndefined();

    back().click();
    expect(crumb()).toBe("Port Forwarding");
    back().click(); // 第一步的 Back 禁用/无动作,不应把向导弄坏
    expect(crumb()).toBe("Port Forwarding");
  });

  it("Remote / Dynamic 的第二步标题与字段标签随类型变化", async () => {
    await mount();
    (document.querySelector(".fwd-new-main") as HTMLButtonElement).click();

    choseKind("Remote");
    expect(crumb()).toBe("Remote Rule");
    expect(wizTitle()).toBe("Remote Port Forwarding");
    expect(caps()).toEqual(["Remote port number *", "Bind address"]);
    expect(hints().at(-1)).toContain("will be open on the remote machine");

    document.body.innerHTML = "";
    baseFakeData();
    vi.resetModules();
    await mount();
    (document.querySelector(".fwd-new-main") as HTMLButtonElement).click();
    choseKind("Dynamic");
    expect(wizTitle()).toBe("Dynamic Port Forwarding");
    expect(hints().at(-1)).toContain("This port will run the SOCKS proxy");
  });

  it("第三步选择中间主机:空选择不前进;菜单列出 Personal vault 与主机(含 key 标记)", async () => {
    await mount();
    (document.querySelector(".fwd-new-main") as HTMLButtonElement).click();
    next().click(); // step2
    typeField("port", "8080");
    next().click(); // step3

    expect(wizTitle()).toBe("Intermediate host");
    expect(hints().at(-1)).toBe("This device is used as an intermediate host to access the remote host.");
    const selectBtn = wizRoot().querySelector(".fwd-wiz-body button.btn") as HTMLButtonElement;
    expect(selectBtn.textContent).toBe("Select a host");

    next().click(); // 未选主机 → 不前进
    expect(wizTitle()).toBe("Intermediate host");

    selectBtn.click();
    const menu = wizRoot().querySelector(".fwd-hostmenu") as HTMLElement;
    expect(menu.querySelector(".fwd-hostgroup")!.textContent).toBe("Personal vault");
    const items = [...menu.querySelectorAll<HTMLElement>(".fwd-hostitem")];
    expect(items.map((i) => i.querySelector(".hn")!.textContent)).toEqual(["node-1", "node-2"]);
    expect(items.map((i) => i.querySelector(".hs")!.textContent)).toEqual(["ssh, root", "ssh, key, root"]);

    items[1].click();
    expect(wizRoot().querySelector(".fwd-hostmenu")).toBeNull();
    expect((wizRoot().querySelector(".fwd-wiz-body button.btn") as HTMLButtonElement).textContent).toBe("node-2");
  });

  it("第四步目的主机为空时不保存;填完保存整条规则,向导关闭并刷新列表", async () => {
    await mount();
    (document.querySelector(".fwd-new-main") as HTMLButtonElement).click();
    next().click();
    typeField("port", "8080");
    typeField("bind", ""); // 清空绑定地址 → 保存时回落到 0.0.0.0
    next().click();
    pickHost("node-2");
    next().click();

    expect(crumb()).toBe("Local Rule");
    expect(wizTitle()).toBe("Destination host");
    expect(caps()).toEqual(["Destination address *", "Destination port number *"]);
    expect(next().textContent).toBe("Save");

    next().click(); // 必填为空 → 不保存
    expect(calls["fwd.save"]).toBeUndefined();
    expect(wiz()).toBeTruthy();

    typeField("dest", "db.internal");
    typeField("destport", "abc"); // 非数字 → 0,必填校验拦住
    next().click();
    expect(calls["fwd.save"]).toBeUndefined();
    expect(wiz()).toBeTruthy();

    typeField("destport", "5432");
    next().click();
    await waitFor(() => wiz() === null, "wizard closed");

    const savedRule = saved.at(-1)!;
    expect(savedRule.id).toMatch(/^f_/);
    expect(savedRule).toMatchObject({
      hostId: "h2",
      kind: "local",
      bindAddress: "0.0.0.0",
      port: 8080,
      destinationAddress: "db.internal",
      destinationPort: 5432,
    });
    expect(savedRule.remoteBindAddress).toBeUndefined();
    expect(savedRule.label).toBeUndefined();
    /* 保存后列表里应出现这条规则(刷新而不是只关窗口) */
    await waitFor(() => rowEls().length === 2, "list refreshed");
    expect(subText(savedRule.id)).toBe("0.0.0.0:8080 → db.internal:5432 via node-2");
  });

  it("Skip wizard 关闭向导但不保存", async () => {
    await mount();
    const listCalls = calls["fwd.rules"]!.length;
    (document.querySelector(".fwd-new-main") as HTMLButtonElement).click();
    expect(wiz()).toBeTruthy();

    skip().click();
    expect(wiz()).toBeNull();
    expect(calls["fwd.save"]).toBeUndefined();
    expect(calls["fwd.rules"]!.length).toBeGreaterThan(listCalls);
  });

  it("Back 会保留已填草稿(端口不丢)", async () => {
    await mount();
    (document.querySelector(".fwd-new-main") as HTMLButtonElement).click();
    next().click();
    typeField("port", "9090");
    next().click(); // step3
    expect(wizTitle()).toBe("Intermediate host");

    back().click();
    expect(wizTitle()).toBe("Local Port Forwarding");
    expect(field("port").value).toBe("9090");

    back().click();
    expect(crumb()).toBe("Port Forwarding");
  });
});

describe("编辑转发规则", () => {
  it("编辑复用同一向导:字段预填、标题带 editing、保存沿用原 id 与自定义名", async () => {
    rules = [RULE({ id: "r-remote", label: "tunnel", hostId: "h2", kind: "remote",
      bindAddress: "0.0.0.0", port: 2222, destinationAddress: "127.0.0.1", destinationPort: 22 })];
    statuses = new Map([["r-remote", STATUS("r-remote", { state: "stopped" })]]);
    await mount();

    btn(row("r-remote"), 0).click();
    expect(crumb()).toBe("Edit rule");
    next().click(); // step2
    expect(crumb()).toBe("Remote Rule · editing");
    expect(field("port").value).toBe("2222");
    expect(field("bind").value).toBe("0.0.0.0");
    next().click(); // step3
    expect((wizRoot().querySelector(".fwd-wiz-body button.btn") as HTMLButtonElement).textContent).toBe("node-2");
    next().click(); // step4
    expect(field("dest").value).toBe("127.0.0.1");
    expect(field("destport").value).toBe("22");

    typeField("destport", "2200");
    next().click();
    await waitFor(() => wiz() === null, "saved");

    const savedRule = saved.at(-1)!;
    expect(savedRule.id).toBe("r-remote");
    expect(savedRule.label).toBe("tunnel");
    expect(savedRule.kind).toBe("remote");
    expect(savedRule.destinationPort).toBe(2200);
    /* remote:bindAddress 给本地侧(不用),远端绑定地址必须写 remoteBindAddress */
    expect(savedRule.bindAddress).toBe("0.0.0.0");
    expect(savedRule.remoteBindAddress).toBe("0.0.0.0");
  });

  it("编辑 remote 规则时用 remoteBindAddress 预填 Bind address(回归:曾被写反)", async () => {
    rules = [RULE({ id: "r-rb", hostId: "h2", kind: "remote", bindAddress: "0.0.0.0",
      remoteBindAddress: "127.0.0.1", port: 2200, destinationAddress: "127.0.0.1", destinationPort: 22 })];
    statuses = new Map([["r-rb", STATUS("r-rb", { state: "stopped" })]]);
    await mount();

    btn(row("r-rb"), 0).click();
    next().click(); // step2
    expect(field("bind").value).toBe("127.0.0.1");
    expect(field("port").value).toBe("2200");
  });

  it("编辑规则时原中间主机已被删除 → 第三步如实显示 Select a host", async () => {
    rules = [RULE({ id: "r-ghost", hostId: "h-deleted", port: 18080 })];
    statuses = new Map([["r-ghost", STATUS("r-ghost", { state: "stopped" })]]);
    await mount();

    btn(row("r-ghost"), 0).click();
    next().click(); // step2(端口已预填,可前进)
    next().click(); // step3
    expect(wizTitle()).toBe("Intermediate host");
    expect((wizRoot().querySelector(".fwd-wiz-body button.btn") as HTMLButtonElement).textContent).toBe("Select a host");
  });

  it("运行中的规则不能编辑(按钮禁用)", async () => {
    rules = [RULE({ id: "r1" })];
    statuses = new Map([["r1", STATUS("r1", { state: "running" })]]);
    await mount();
    expect(btn(row("r1"), 0).disabled).toBe(true);
  });
});

describe("Remote 绑定地址与浏览器回归", () => {
  it("Remote 类型的 Bind address 落到 remoteBindAddress,本地侧 bindAddress 不参与", async () => {
    /*
     * 证据链:
     *  - src/shared/forward.ts:`remoteBindAddress?: string; // remote:远端绑定地址`
     *  - src/main/forward.ts:229 `const bindAddr = rule.remoteBindAddress || "0.0.0.0";`
     *    并在 stop 时用同一字段 `unforwardIn(...)`;remote 型不读 `bindAddress`。
     *  - 向导第二步对 Remote 显示了 `Bind address` 输入框,但保存时只写 `bindAddress`
     *    → 用户填的远端绑定地址被引擎完全忽略(-R 永远绑 0.0.0.0)。
     * 期望:Remote 规则保存时把该输入写入 `remoteBindAddress`(或引擎改读 bindAddress),
     * 两条路都可以,但不能"显示一个没有效果的输入框"。
     */
    await mount();
    (document.querySelector(".fwd-new-main") as HTMLButtonElement).click();
    choseKind("Remote");
    typeField("port", "2222");
    typeField("bind", "127.0.0.1");
    next().click(); // step3
    pickHost("node-1");
    next().click(); // step4
    typeField("dest", "127.0.0.1");
    typeField("destport", "19090");
    next().click();
    await waitFor(() => wiz() === null, "wizard closed");

    const savedRule = saved.at(-1)!;
    expect(savedRule.remoteBindAddress).toBe("127.0.0.1");
    expect(savedRule.bindAddress).toBe("0.0.0.0");
  });

  it("Remote 类型清空 Bind address 时回落到 0.0.0.0(不留空串)", async () => {
    await mount();
    (document.querySelector(".fwd-new-main") as HTMLButtonElement).click();
    choseKind("Remote");
    typeField("port", "2222");
    typeField("bind", "");
    next().click(); // step3
    pickHost("node-1");
    next().click(); // step4
    typeField("dest", "127.0.0.1");
    typeField("destport", "19090");
    next().click();
    await waitFor(() => wiz() === null, "wizard closed");

    expect(saved.at(-1)!.remoteBindAddress).toBe("0.0.0.0");
  });
});
