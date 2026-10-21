import { bridge } from "./hosts";
import { tr } from "../shared/i18n";
import type { HostKeyAsk, KnownHostRow } from "../shared/knownhost";

/* T6 复刻 —— 已知主机视图 + 主机密钥询问对话框。
   文案逐字取自原版自身代码(F18):
     未知主机(首连):
       标题 tr("kh.connectConfirm")
       正文 "The authenticity of <host> can not be established." / "<keyType> fingerprint is SHA256:<fp>"
            / tr("kh.addPrompt")
       按钮 Close / Continue / tr("kh.addAndContinue")
     指纹变更:
       标题 "The fingerprint for <host> has changed"(error 色)
       正文 tr("kh.breach") / "New <keyType> fingerprint is SHA256:<fp>"
       按钮 Replace / tr("kh.addAsNew") / Cancel
     列表空态:tr("kh.emptyTitle") / tr("kh.emptyDesc")
   注:正文里的产品名按本产品替换为 sshkit(与 T3 同策略),其余原样。 */

export interface KhView {
  el: HTMLElement;
  onShow: () => void;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function toast(msg: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
}

export function createKnownHostsView(): KhView {
  const root = document.createElement("div");
  root.className = "kh";
  root.innerHTML = `
    <div class="kh-bar">
      <span class="kh-bar-title">${tr("kh.title")}</span>
      <span style="flex:1"></span>
      <span class="kh-hint">${tr("kh.note")}</span>
      <button class="btn kh-import" title="${tr("sec.import")}">${tr("sec.import")}</button>
    </div>
    <div class="kh-body"></div>`;
  const body = root.querySelector(".kh-body")! as HTMLElement;
  /* T6:多选。原版字符串里有 `Select All`、`Clear selection`、`Multi-Select Context Menu`,
     说明 Known Hosts 列表支持多选。交互沿用与 SFTP 一致的手感:普通点=单选、
     Cmd/Ctrl+点=切换、Shift+点=从锚点范围选择,Esc=清除。 */
  const sel = new Set<string>();
  let anchor: string | null = null;
  /* 原版 Known Hosts 页工具栏有 `Import`(F18 实测)。导入另一个 known_hosts 文件:
     只并进"本文件没有的条目",不动已有条目,并回报新增/跳过数量。 */
  (root.querySelector(".kh-import")! as HTMLButtonElement).addEventListener("click", async () => {
    try {
      const r = await bridge.knownhost.import();
      if (r.canceled) return;
      toast(r.added ? `Imported ${r.added} known host${r.added === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped}` : ""}` : `Nothing new to import (${r.skipped} skipped)`);
      await refresh();
    } catch (e) {
      toast(`Import failed: ${String((e as Error).message ?? e)}`);
    }
  });

  async function refresh(): Promise<void> {
    const rows = await bridge.knownhost.list();
    if (!rows.length) {
      body.innerHTML = `
        <div class="kh-empty">
          <div class="kh-empty-ico">🔑</div>
          <h3>${tr("kh.emptyTitle")}</h3>
          <p>${tr("kh.emptyDesc")}</p>
        </div>`;
      return;
    }
    const list = document.createElement("div");
    list.className = "kh-list";
    for (const r of rows) list.append(row(r));
    const bar = document.createElement("div");
    bar.className = "kh-selbar";
    if (sel.size) {
      bar.innerHTML = `<span class="kh-selcount"></span><span style="flex:1"></span>
        <button class="btn kh-sel-all">${tr("common.selectAll")}</button>
        <button class="btn danger kh-sel-del">Delete</button>
        <button class="btn kh-sel-clear">${tr("common.clearSelection")}</button>`;
      (bar.querySelector(".kh-selcount")! as HTMLElement).textContent =
        `${sel.size} selected`;
      (bar.querySelector(".kh-sel-all")! as HTMLElement).addEventListener("click", () => {
        for (const r of rows) if (!r.hashed) sel.add(r.host);
        void refresh();
      });
      (bar.querySelector(".kh-sel-clear")! as HTMLElement).addEventListener("click", () => {
        sel.clear(); anchor = null; void refresh();
      });
      (bar.querySelector(".kh-sel-del")! as HTMLElement).addEventListener("click", () => { void removeSelected(); });
    }
    body.replaceChildren(bar, list);
  }

  /** 删除全部选中项(哈希化条目跳过) */
  async function removeSelected(): Promise<void> {
    const targets = [...sel];
    let done = 0;
    for (const host of targets) {
      try { await bridge.knownhost.remove(host); done++; } catch { /* 单个失败不打断 */ }
    }
    sel.clear(); anchor = null;
    toast(`Removed ${done}/${targets.length}`);
    await refresh();
  }

  function row(r: KnownHostRow): HTMLElement {
    const el = document.createElement("div");
    el.className = `kh-row${sel.has(r.host) ? " sel" : ""}`;
    el.innerHTML = `
      <span class="kh-ico">🔑</span>
      <span class="kh-main"><span class="kh-host"></span><span class="kh-fp"></span></span>
      <span class="kh-type"></span>
      <button class="btn danger kh-del" title=tr("kh.remove")>✕</button>`;
    (el.querySelector(".kh-host")! as HTMLElement).textContent = r.host;
    (el.querySelector(".kh-fp")! as HTMLElement).textContent = r.fingerprint;
    (el.querySelector(".kh-type")! as HTMLElement).textContent = r.keyType;
    const del = el.querySelector(".kh-del")! as HTMLButtonElement;
    del.disabled = r.hashed;
    if (r.hashed) del.title = "哈希化条目无法按主机名删除";
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      /* 失败要说话:以前这里没有 catch,失败只剩 unhandled rejection —— 行还在,用户不知道为什么。 */
      try {
        await bridge.knownhost.remove(r.host);
        sel.delete(r.host);
        await refresh();
      } catch (err) {
        toast(`Failed to remove ${r.host}: ${String((err as Error).message ?? err)}`);
      }
    });
    el.addEventListener("click", (ev) => {
      if (r.hashed) return;                       // 哈希化条目无法按主机名定位,不参与多选
      if (ev.shiftKey && anchor) {
        const names = [...document.querySelectorAll(".kh-row .kh-host")].map((n) => n.textContent!);
        const i = names.indexOf(anchor), j = names.indexOf(r.host);
        if (i >= 0 && j >= 0) {
          sel.clear();
          for (const n of names.slice(Math.min(i, j), Math.max(i, j) + 1)) sel.add(n);
        }
      } else if (ev.metaKey || ev.ctrlKey) {
        if (sel.has(r.host)) sel.delete(r.host); else sel.add(r.host);
        anchor = r.host;
      } else {
        sel.clear(); sel.add(r.host); anchor = r.host;
      }
      void refresh();
    });
    return el;
  }

  root.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && sel.size) { sel.clear(); anchor = null; void refresh(); }
  });
  return { el: root, onShow: () => void refresh() };
}

/* ---------- 主机密钥询问 ---------- */

export function installHostKeyDialog(): void {
  bridge.knownhost.onAsk((req: HostKeyAsk) => show(req));
  // 会话已结束的询问要撤掉,别留个点不动的对话框
  bridge.knownhost.onAskCancel((reqId: string) => {
    const el = document.querySelector(`.hk-backdrop[data-req="${reqId}"]`);
    el?.remove();
  });
}

function show(req: HostKeyAsk): void {
  // 一次只显示一个:新的询问要**替换**旧的。
  // (原先直接 return 会把新询问丢掉,导致那次连接永远卡在握手 —— 实测踩到)
  document.querySelectorAll(".hk-backdrop").forEach((e) => e.remove());
  const changed = req.status === "changed";

  const back = document.createElement("div");
  back.className = "hk-backdrop";
  back.dataset.req = req.reqId;
  back.innerHTML = `
    <div class="hk-dialog">
      <h3 class="${changed ? "error" : "primary"}"></h3>
      <div class="hk-body"></div>
      <div class="hk-actions"></div>
    </div>`;
  const title = back.querySelector("h3")! as HTMLElement;
  const bodyEl = back.querySelector(".hk-body")! as HTMLElement;
  const actions = back.querySelector(".hk-actions")! as HTMLElement;

  const fpLine = (lead: string): string =>
    `${esc(lead)}<br><br>${esc(req.keyType)} fingerprint is SHA256:<br><span class="hk-fp">${esc(req.fingerprint)}</span>`;

  if (changed) {
    title.textContent = tr("dlg.hostKeyChanged", { host: req.host });
    bodyEl.innerHTML = `${esc(tr("dlg.hostKeyBreach"))}<br><br>New ${esc(req.keyType)} fingerprint is SHA256:<br><span class="hk-fp">${esc(req.fingerprint)}</span>`;
  } else {
    title.textContent = tr("dlg.hostKeyTitle");
    bodyEl.innerHTML = `${fpLine(tr("dlg.hostKeyDesc", { host: req.host }))}<br><br>${esc(tr("dlg.hostKeyAsk"))}`;
  }

  const answer = (action: "continue" | "add" | "replace" | "cancel"): void => {
    bridge.knownhost.answer(req.reqId, action);
    back.remove();
  };
  const btn = (label: string, cls: string, action: "continue" | "add" | "replace" | "cancel"): void => {
    const b = document.createElement("button");
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", () => answer(action));
    actions.append(b);
  };

  if (changed) {
    btn(tr("dlg.replace"), "primary", "replace");
    btn(tr("dlg.addAsNew"), "", "add");
    btn(tr("form.cancel"), "danger", "cancel");
  } else {
    btn(tr("dlg.closeOnly"), "", "cancel");
    btn(tr("dlg.continue"), "", "continue");
    btn(tr("dlg.addContinue"), "primary", "add");
  }

  document.body.append(back);
}
