/* MCP 分区:把"服务器状态 + 客户端 + 每次调用的活动流"画出来。
   用户的原话是"AI 通过 MCP 操作,但是我得看得见" —— 所以这里的重点是
   可读的调用记录(谁、调了什么、参数、结果、耗时),而不是服务器配置本身。 */

import { bridge } from "./hosts";
import { tr } from "../shared/i18n";
import type { McpActivity, McpApprovalRequest, McpPolicy, McpStatus } from "../shared/mcp";

/** 权限档的中文/英文标签 */
export function policyLabel(p: McpPolicy): string {
  if (p === "read-only") return tr("mcp.policyReadOnly");
  if (p === "standard") return tr("mcp.policyStandard");
  return tr("mcp.policyFull");
}

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
    /* 键名直接用协议名:两个入口一眼能分清是哪种传输 */
    mcpServers: {
      "sshkit-streamable-http": {
        type: "http",
        url: `http://127.0.0.1:${s.port}/mcp`,
        headers: { Authorization: `Bearer ${s.token}` },
      },
      "sshkit-http-sse": {
        type: "sse",
        url: `http://127.0.0.1:${s.port}/sse`,
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
  const card = document.createElement("div");
  card.className = "mcp-card";

  /* ---- 第一行:状态 / 地址 / 开关 ---- */
  const top = document.createElement("div");
  top.className = "mcp-top";
  const pill = document.createElement("span");
  pill.className = `mcp-pill ${s.running ? "on" : "off"}`;
  pill.textContent = s.running ? tr("mcp.running") : tr("mcp.stopped");
  const addr = document.createElement("div");
  addr.className = "mcp-addr";
  if (s.running) {
    const line = (proto: string, path: string): HTMLElement => {
      const row = document.createElement("div");
      row.className = "mcp-addr-row";
      const p = document.createElement("span");
      p.className = "mcp-proto";
      p.textContent = proto;
      const u = document.createElement("code");
      u.textContent = `http://127.0.0.1:${s.port}${path}`;
      row.append(p, u);
      return row;
    };
    addr.append(line(tr("mcp.protoStreamable"), "/mcp"), line(tr("mcp.protoSse"), "/sse"));
  } else {
    addr.textContent = tr("mcp.offHint");
  }
  const toggle = document.createElement("button");
  toggle.className = `mcp-btn ${s.running ? "danger" : "primary"}`;
  toggle.textContent = s.running ? tr("mcp.disable") : tr("mcp.enable");
  toggle.addEventListener("click", () => {
    void bridge.mcp.set({ enabled: !s.running }).then((st) => { current = st; paintMcp(box, st); });
  });
  const spacer = document.createElement("span");
  spacer.className = "mcp-spacer";
  top.append(pill, addr, spacer, toggle);
  if (s.error) {
    const err = document.createElement("div");
    err.className = "mcp-err";
    err.textContent = s.error;
    top.append(err);
  }

  /* ---- 第二行:客户端 / 权限档 ---- */
  const meta = document.createElement("div");
  meta.className = "mcp-meta";
  const clients = document.createElement("span");
  clients.className = "mcp-clients";
  clients.textContent = s.clients.length > 0
    ? tr("mcp.connected", { who: s.clients.join(" · ") })
    : tr("mcp.noClient");
  const modeClass: Record<McpPolicy, string> = { full: "full", standard: "std", "read-only": "ro" };
  const mode = document.createElement("span");
  mode.className = `mcp-mode ${modeClass[s.policy]}`;
  mode.textContent = `${tr("mcp.policy")}:${policyLabel(s.policy)}`;
  meta.append(clients, mode);

  /* ---- 第三行:操作(顺序保持不变:停用/复制/换令牌/全部中断 + 权限下拉) ---- */
  const actions = document.createElement("div");
  actions.className = "mcp-actions";
  const mk = (label: string, cls: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = `mcp-btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  };
  const copy = mk(tr("mcp.copyConfig"), "ghost", () => { void bridge.clipboard.write(clientConfig(s)); });
  const regen = mk(tr("mcp.regenerate"), "ghost", () => {
    void bridge.mcp.regenerateToken().then((st) => { current = st; paintMcp(box, st); });
  });
  const stop = mk(tr("mcp.stop"), "danger", () => { void bridge.mcp.abort(); });
  const policy = document.createElement("select");
  policy.className = "mcp-policy";
  for (const p of ["read-only", "standard", "full"] as const) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = policyLabel(p);
    opt.selected = s.policy === p;
    policy.append(opt);
  }
  policy.addEventListener("change", () => {
    void bridge.mcp.set({ policy: policy.value as McpPolicy }).then((st) => { current = st; paintMcp(box, st); });
  });
  actions.append(copy, regen, stop, policy);

  /* ---- 配置预览(只读;复制按钮给客户端配置) ---- */
  const cfg = document.createElement("pre");
  cfg.className = "mcp-cfg";
  cfg.textContent = clientConfig(s);

  const hint = document.createElement("div");
  hint.className = "mcp-hint";
  hint.textContent = tr("mcp.hint");

  card.append(top, meta, actions, cfg, hint);
  box.append(card);
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
  const chev = document.createElement("span");
  chev.className = "mcp-act-chev";
  chev.textContent = "›";
  head.append(chev);
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
  bridge.mcp.onApproval((req: McpApprovalRequest) => { showApproval(req); });
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

/** 标准档批准弹层:显示工具名与参数,允许/拒绝(不点则 60s 后主进程按拒绝处理) */
export function showApproval(req: McpApprovalRequest): void {
  document.querySelector(".mcp-approve")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "mcp-approve";
  wrap.innerHTML = `<div class="mcp-approve-box">
    <div class="mcp-approve-title"></div>
    <pre class="mcp-approve-args"></pre>
    <div class="mcp-approve-actions">
      <button class="mcp-btn ghost" data-act="deny"></button>
      <button class="mcp-btn primary" data-act="allow"></button>
    </div>
  </div>`;
  (wrap.querySelector(".mcp-approve-title") as HTMLElement).textContent = `${tr("mcp.approveTitle")}  ${req.tool}`;
  (wrap.querySelector(".mcp-approve-args") as HTMLElement).textContent = req.args;
  const btn = (act: string): HTMLElement => wrap.querySelector(`[data-act="${act}"]`) as HTMLElement;
  (btn("allow")).textContent = tr("mcp.approve");
  (btn("deny")).textContent = tr("mcp.deny");
  const close = (ok: boolean): void => {
    void bridge.mcp.answerApproval(req.id, ok);
    wrap.remove();
  };
  btn("allow").addEventListener("click", () => close(true));
  btn("deny").addEventListener("click", () => close(false));
  document.body.append(wrap);
}
