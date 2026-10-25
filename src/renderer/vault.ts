/** 主机簿加密备份的界面层:菜单 + 密码输入框。
 *  真正的加解密在主进程(src/main/vault.ts),这里只负责"问密码"和展示结果。 */

import { tr } from "../shared/i18n";

/** 询问导出/导入密码;返回 null 表示取消。密码不回显,低于最小长度时行内报错。 */
export function promptPassphrase(title: string, hint: string, minLength: number): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "discard-dlg vault-pass-dlg";
    wrap.innerHTML = `<div class="dd-box" role="dialog" aria-modal="true">
      <div class="dd-head"><span></span><button class="dd-x" aria-label="close">✕</button></div>
      <div class="dd-body">
        <p class="pd-hint"></p>
        <input class="pd-input" type="password" autocomplete="new-password" spellcheck="false">
        <p class="vault-pass-err" hidden></p>
        <div class="pd-actions"><button class="dd-cancel"></button><button class="dd-ok"></button></div>
      </div>
    </div>`;
    (wrap.querySelector(".dd-head span") as HTMLElement).textContent = title;
    const hintEl = wrap.querySelector(".pd-hint") as HTMLElement;
    hintEl.textContent = hint;
    hintEl.hidden = hint === "";
    const input = wrap.querySelector(".pd-input") as HTMLInputElement;
    const err = wrap.querySelector(".vault-pass-err") as HTMLElement;
    (wrap.querySelector(".dd-cancel") as HTMLElement).textContent = tr("form.cancel");
    (wrap.querySelector(".dd-ok") as HTMLElement).textContent = tr("common.ok");
    const done = (v: string | null): void => { wrap.remove(); resolve(v); };
    wrap.querySelector(".dd-x")!.addEventListener("click", () => done(null));
    wrap.querySelector(".dd-cancel")!.addEventListener("click", () => done(null));
    wrap.addEventListener("click", (ev) => { if (ev.target === wrap) done(null); });
    const submit = (): void => {
      if (input.value.length < minLength) {
        err.textContent = tr("vault.passTooShort", { n: String(minLength) });
        err.hidden = false;
        input.focus();
        return;
      }
      done(input.value);
    };
    wrap.querySelector(".dd-ok")!.addEventListener("click", submit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") submit();
      if (ev.key === "Escape") done(null);
    });
    document.body.append(wrap);
    input.focus();
  });
}

export interface VaultMenuItem { label: string; onClick: () => void }

/** 主机页工具条的「更多」弹出菜单(导出/导入等);点外部或按 Esc 关闭 */
export function showVaultMenu(anchor: HTMLElement, items: VaultMenuItem[]): void {
  const menu = document.createElement("div");
  menu.className = "vault-menu";
  for (const it of items) {
    const b = document.createElement("button");
    b.className = "vault-menu-item";
    b.textContent = it.label;
    b.addEventListener("click", () => { menu.remove(); it.onClick(); });
    menu.append(b);
  }
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.style.right = `${Math.round(window.innerWidth - r.right)}px`;
  document.body.append(menu);
  const off = (ev: Event): void => {
    if (ev instanceof MouseEvent && menu.contains(ev.target as Node)) return;
    menu.remove();
    document.removeEventListener("mousedown", off);
    document.removeEventListener("keydown", onKey as EventListener);
  };
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === "Escape") off(ev); };
  /* 同步挂监听:本次 click 已经派发完,不会再被同一次点击关掉 */
  document.addEventListener("mousedown", off);
  document.addEventListener("keydown", onKey as EventListener);
}
