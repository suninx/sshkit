/* 多主机命令面板:勾主机 → 写一条命令 → 并行/串行执行 → 结果并排。
   与「广播输入」是两个独立入口:广播要求开着终端,面板不需要。
   执行走主进程的 multiexec:run(内部复用与 MCP ssh_exec 相同的执行层)。 */

import { bridge } from "./hosts";
import { tr } from "../shared/i18n";
import type { HostRecord } from "../shared/host";

export interface MultiExecRow {
  hostId: string;
  hostName: string;
  state: "running" | "done" | "error";
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
  truncated: boolean;
}

/** 结果摘要(给标题栏显示 "3 台:2 成功 / 1 失败") */
export function summarizeRows(rows: MultiExecRow[]): { total: number; ok: number; failed: number; running: number } {
  return {
    total: rows.length,
    ok: rows.filter((r) => r.state === "done" && r.exitCode === 0).length,
    failed: rows.filter((r) => r.state === "error" || (r.state === "done" && r.exitCode !== 0)).length,
    running: rows.filter((r) => r.state === "running").length,
  };
}

let panel: HTMLElement | null = null;
/** 实时结果订阅的取消函数(关闭面板时必须摘掉,否则事件会打到已移除的 DOM) */
let offResult: (() => void) | null = null;

/** 关闭面板(测试与 ESC 用) */
export function closeMultiExec(): void {
  offResult?.();
  offResult = null;
  panel?.remove();
  panel = null;
}

/** 打开面板;hosts 由调用方传入(已 list 过的主机) */
export function openMultiExec(hosts: HostRecord[]): void {
  closeMultiExec();
  const wrap = document.createElement("div");
  wrap.className = "me-overlay";
  wrap.innerHTML = `<div class="me-panel">
    <div class="me-head"><span class="me-title"></span><button class="me-x" data-act="close">✕</button></div>
    <div class="me-hosts"></div>
    <textarea class="me-cmd" spellcheck="false"></textarea>
    <div class="me-opts">
      <label><input type="radio" name="me-mode" value="parallel" checked><span></span></label>
      <label><input type="radio" name="me-mode" value="serial"><span></span></label>
      <span class="me-spacer"></span>
      <button class="mcp-btn danger" data-act="cancel"></button>
      <button class="mcp-btn primary" data-act="run"></button>
    </div>
    <div class="me-summary"></div>
    <div class="me-rows"></div>
  </div>`;
  panel = wrap;

  const q = <T extends HTMLElement>(sel: string): T => wrap.querySelector(sel) as T;
  q(".me-title").textContent = tr("me.title");
  const closeBtn = q('[data-act="close"]');
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => closeMultiExec());
  q('[data-act="run"]').textContent = tr("me.run");
  q('[data-act="cancel"]').textContent = tr("me.cancelAll");
  (q(".me-cmd") as HTMLTextAreaElement).placeholder = tr("me.placeholder");
  const modeLabels = wrap.querySelectorAll(".me-opts label span");
  modeLabels[0].textContent = tr("me.parallel");
  modeLabels[1].textContent = tr("me.serial");

  /* 主机勾选 */
  const hostBox = q(".me-hosts");
  if (hosts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "me-empty";
    empty.textContent = tr("me.noHosts");
    hostBox.append(empty);
  } else {
    for (const h of hosts) {
      const lab = document.createElement("label");
      lab.className = "me-host";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = h.id;
      cb.checked = true;
      const name = document.createElement("span");
      name.textContent = `${h.name}  ${h.host}`;
      lab.append(cb, name);
      hostBox.append(lab);
    }
  }

  const rowsBox = q(".me-rows");
  const summary = q(".me-summary");
  const rows = new Map<string, MultiExecRow>();
  const rowEl = (row: MultiExecRow): HTMLElement => {
    const el = document.createElement("div");
    el.className = `me-row ${row.state}`;
    el.dataset.hostId = row.hostId;
    el.innerHTML = `<div class="me-row-head"><span class="me-host-name"></span><span class="me-exit"></span><span class="me-ms"></span></div>
      <pre class="me-out" hidden></pre>`;
    (el.querySelector(".me-host-name") as HTMLElement).textContent = row.hostName;
    const exit = el.querySelector(".me-exit") as HTMLElement;
    exit.textContent = row.state === "running" ? tr("me.running")
      : `${tr("me.exit")} ${row.exitCode}`;
    (el.querySelector(".me-ms") as HTMLElement).textContent = row.state === "running" ? "" : `${row.ms}ms`;
    const out = el.querySelector(".me-out") as HTMLElement;
    out.textContent = [row.stdout, row.stderr].filter(Boolean).join("\n").trim() || tr("me.noOutput");
    (el.querySelector(".me-row-head") as HTMLElement).addEventListener("click", () => { out.hidden = !out.hidden; });
    return el;
  };
  const paint = (): void => {
    rowsBox.replaceChildren(...[...rows.values()].map(rowEl));
    const s = summarizeRows([...rows.values()]);
    summary.textContent = rows.size === 0 ? "" : tr("me.summary", { total: String(s.total), ok: String(s.ok), failed: String(s.failed) });
  };

  /* 实时结果 */
  offResult = bridge.multiexec.onResult((ev) => {
    const e = ev as MultiExecRow & { state: string };
    const prev = rows.get(e.hostId);
    /* 事件由主进程产生:running 时没有输出字段,其余字段一定齐全 */
    rows.set(e.hostId, {
      hostId: e.hostId, hostName: e.hostName, state: e.state as MultiExecRow["state"],
      exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr, ms: e.ms, truncated: e.truncated,
    });
    if (!prev || prev.state === "running") paint();
  });
  q('[data-act="cancel"]').addEventListener("click", () => { void bridge.multiexec.cancel(); });
  q('[data-act="run"]').addEventListener("click", () => {
    const cmd = (q(".me-cmd") as HTMLTextAreaElement).value.trim();
    if (!cmd) return;
    const ids = [...wrap.querySelectorAll<HTMLInputElement>(".me-host input:checked")].map((i) => i.value);
    if (ids.length === 0) return;
    rows.clear();
    /* ids 来自渲染出来的主机勾选框,一定能在 hosts 里找到 */
    const nameOf = new Map(hosts.map((h) => [h.id, h.name]));
    for (const id of ids) {
      rows.set(id, { hostId: id, hostName: nameOf.get(id)!, state: "running", exitCode: 0, stdout: "", stderr: "", ms: 0, truncated: false });
    }
    paint();
    const mode = (wrap.querySelector('input[name="me-mode"]:checked') as HTMLInputElement).value as "parallel" | "serial";
    void bridge.multiexec.run(ids, cmd, { mode }).then((res) => {
      for (const r of res) rows.set(r.hostId, { ...r, state: r.exitCode === 0 ? "done" : "error" });
      paint();
    });
  });

  paint();          // 初始空态(摘要行留空)
  document.body.append(wrap);
}

/** 供 app.ts 判断面板是否开着 */
export const isMultiExecOpen = (): boolean => panel !== null;
