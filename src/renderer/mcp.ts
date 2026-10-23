/* MCP 分区:把"服务器状态 + 客户端 + 每次调用的活动流"画出来。
   用户的原话是"AI 通过 MCP 操作,但是我得看得见" —— 所以这里的重点是
   可读的调用记录(谁、调了什么、参数、结果、耗时),而不是服务器配置本身。 */

import { bridge } from "./hosts";
import { tr } from "../shared/i18n";
import type { McpActivity, McpStatus } from "../shared/mcp";

const fmtTime = (at: number): string => {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const statusText = (s: McpCallStatusLike): string => {
  if (s === "running") return tr("mcp.stRunning");
  if (s === "ok") return tr("mcp.stOk");
  if (s === "cancelled") return tr("mcp.stCancelled");
  return tr("mcp.stError");
};
type McpCallStatusLike = McpActivity["status"];

/** 一行活动的标题:工具名 + 关键参数(host/path),让用户不用展开也能看懂在干什么 */
export function activityTitle(ev: McpActivity): string {
  if (ev.tool === "-") return ev.method;
  let hint = "";
  if (ev.args) {
    try {
      const a = JSON.parse(ev.args) as { host?: unknown; path?: unknown; dir?: unknown };
      hint = [a.host, a.path ?? a.dir].filter((x) => typeof x === "string" && x !== "").join(" ");
    } catch { /* 参数不是 JSON(被截断)就只显示工具名 */ }
  }
  return hint ? `${ev.tool}  ${hint}` : ev.tool;
}

/** 复制到剪贴板的客户端配置(Streamable HTTP;Claude Code / Codex / VS Code 都用这种写法) */
export function clientConfig(s: McpStatus): string {
  return JSON.stringify({
    mcpServers: {
      sshkit: {
        type: "http",
        url: `http://127.0.0.1:${s.port}/mcp`,
        headers: { Authorization: `Bearer ${s.token}` },
      },
    },
  }, null, 2);
}

let current: McpStatus | null = null;

/** 渲染整个分区(状态卡 + 活动流) */
export function paintMcp(box: HTMLElement, s: McpStatus): void {
  current = s;
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "mcp-head";

  const line1 = document.createElement("div");
  line1.className = "mcp-line";
  const pill = document.createElement("span");
  pill.className = `mcp-pill ${s.running ? "on" : "off"}`;
  pill.textContent = s.running ? tr("mcp.running") : tr("mcp.stopped");
  const addr = document.createElement("span");
  addr.className = "mcp-addr";
  addr.textContent = s.running ? `http://127.0.0.1:${s.port}/mcp` : tr("mcp.offHint");
  line1.append(pill, addr);
  if (s.error) {
    const err = document.createElement("span");
    err.className = "mcp-err";
    err.textContent = s.error;
    line1.append(err);
  }

  const line2 = document.createElement("div");
  line2.className = "mcp-line";
  const clients = document.createElement("span");
  clients.className = "mcp-clients";
  clients.textContent = s.clients.length > 0
    ? tr("mcp.connected", { who: s.clients.join(", ") })
    : tr("mcp.noClient");
  line2.append(clients);

  const line3 = document.createElement("div");
  line3.className = "mcp-line mcp-actions";
  const mk = (label: string, cls: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = `mcp-btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  };
  const toggle = mk(s.running ? tr("mcp.disable") : tr("mcp.enable"), s.running ? "danger" : "primary", () => {
    void bridge.mcp.set({ enabled: !s.running }).then((st) => { current = st; paintMcp(box, st); });
  });
  const copy = mk(tr("mcp.copyConfig"), "", () => {
    void bridge.clipboard.write(clientConfig(s));
  });
  const regen = mk(s.running ? tr("mcp.regenerate") : tr("mcp.regenerate"), "ghost", () => {
    void bridge.mcp.regenerateToken().then((st) => { current = st; paintMcp(box, st); });
  });
  line3.append(toggle, copy, regen);
  head.append(line1, line2, line3);

  const hint = document.createElement("div");
  hint.className = "mcp-hint";
  hint.textContent = tr("mcp.hint");

  box.append(head, hint);
}

/** 活动行(可点开看参数/结果) */
export function activityRow(ev: McpActivity): HTMLElement {
  const row = document.createElement("div");
  row.className = `mcp-act ${ev.status}`;
  const head = document.createElement("div");
  head.className = "mcp-act-head";
  const time = document.createElement("span");
  time.className = "mcp-act-time";
  time.textContent = fmtTime(ev.at);
  const who = document.createElement("span");
  who.className = "mcp-act-who";
  who.textContent = ev.client;
  const title = document.createElement("span");
  title.className = "mcp-act-title";
  title.textContent = activityTitle(ev);
  const st = document.createElement("span");
  st.className = "mcp-act-status";
  st.textContent = statusText(ev.status) + (ev.ms === undefined ? "" : ` · ${ev.ms}ms`);
  head.append(time, who, title, st);
  row.append(head);

  const detail: string[] = [];
  if (ev.args) detail.push(`${tr("mcp.arguments")}: ${ev.args}`);
  if (ev.result) detail.push(`${tr("mcp.result")}: ${ev.result}`);
  if (ev.error) detail.push(`${tr("mcp.error")}: ${ev.error}`);
  if (detail.length > 0) {
    const body = document.createElement("pre");
    body.className = "mcp-act-detail";
    body.textContent = detail.join("\n\n");
    body.hidden = true;
    row.append(body);
    head.addEventListener("click", () => { body.hidden = !body.hidden; });
  }
  return row;
}

export interface McpSectionRefs {
  /** 状态卡容器 */
  head: HTMLElement;
  /** 活动列表容器 */
  list: HTMLElement;
}

/** 建分区骨架并订阅事件(返回 refs 供测试与 app.ts 复用) */
export function mountMcpSection(box: HTMLElement): McpSectionRefs {
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "mcp-wrap";
  const list = document.createElement("div");
  list.className = "sec-list mcp-list";
  box.append(head, list);

  /* 活动行按 id 索引:running 行收到最终状态时原地替换(不产生两条) */
  const rows = new Map<number, HTMLElement>();
  const paintActivity = (activity: McpActivity[]): void => {
    list.innerHTML = "";
    rows.clear();
    if (activity.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mcp-empty";
      empty.textContent = tr("mcp.noActivity");
      list.append(empty);
      return;
    }
    for (const ev of activity) {
      const row = activityRow(ev);
      rows.set(ev.id, row);
      list.append(row);
    }
  };

  void bridge.mcp.status().then((st) => {
    current = st;
    paintMcp(head, st);
    paintActivity(st.activity);
  });
  bridge.mcp.onActivity((ev) => {
    if (list.querySelector(".mcp-empty")) list.innerHTML = "";
    const prev = rows.get(ev.id);
    const row = activityRow(ev);
    if (prev) { prev.replaceWith(row); rows.set(ev.id, row); return; }
    rows.set(ev.id, row);
    list.prepend(row);
  });
  bridge.mcp.onStatus((st) => {
    current = st;
    paintMcp(head, st);
  });
  return { head, list };
}

/** 供「清空活动」工具条按钮复用 */
export function currentMcpStatus(): McpStatus | null { return current; }
