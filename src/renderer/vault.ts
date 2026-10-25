/** 主机簿加密备份的界面层:菜单 + 密码输入框。
 *  真正的加解密在主进程(src/main/vault.ts),这里只负责"问密码"和展示结果。 */

import { tr } from "../shared/i18n";

/** 询问导出/导入密码;返回 null 表示取消。密码不回显,低于最小长度时行内报错。 */
export function promptPassphrase(title: string, hint: string, minLength: number): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    /* prompt-dlg 复用 SFTP 那套深色卡片样式,避免白底弹窗 */
    wrap.className = "discard-dlg prompt-dlg vault-pass-dlg";
    wrap.innerHTML = `<div class="dd-box" role="dialog" aria-modal="true">
      <div class="dd-head">
        <svg class="vault-lock" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>
        <span></span><button class="dd-x" aria-label="close">✕</button></div>
      <div class="dd-body">
        <p class="pd-hint"></p>
        <div class="vault-field">
          <input class="pd-input" type="password" autocomplete="off" spellcheck="false">
          <button class="vault-eye" type="button" aria-label="show password" aria-pressed="false" title="show password">
            <svg class="i-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 12S5.5 5.5 12 5.5 22.5 12 22.5 12 18.5 18.5 12 18.5 1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="i-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19.5C5.5 19.5 1.5 12 1.5 12a19.5 19.5 0 0 1 5-5.9"/><path d="M9.9 5.7A10.6 10.6 0 0 1 12 4.5c6.5 0 10.5 7.5 10.5 7.5a19.6 19.6 0 0 1-3.2 4.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M2 2l20 20"/></svg>
          </button>
        </div>
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
    const eye = wrap.querySelector(".vault-eye") as HTMLButtonElement;
    /* 显隐用 class 控制:SVG 不是 HTMLElement,[hidden] 在部分样式表下不生效,
       两个图标会叠在一起(用户反馈"眼睛图标不对")。 */
    const syncEye = (visible: boolean): void => {
      eye.classList.toggle("showing", visible);
      eye.setAttribute("aria-pressed", visible ? "true" : "false");
      const label = visible ? "hide password" : "show password";
      eye.setAttribute("aria-label", label);
      eye.title = label;
    };
    eye.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      syncEye(show);
      input.focus();
    });
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
    (wrap.querySelector(".dd-ok") as HTMLElement).classList.add("vault-ok");
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
