import { bridge } from "./hosts";
import type { ForwardKind, ForwardRule, ForwardStatus } from "../shared/forward";

/* T3 复刻 —— 端口转发面板与向导。
   结构与文案来自原版实测(F17):
     入口:左栏一级导航 Port Forwarding;工具栏 `+ New forwarding`;
     空态:"Set up port forwarding" + "Save port forwarding to access databases, web apps, and other services."
     向导四步(以 Local 为例):
       1) Select the port forwarding type: Local / Remote / Dynamic(各带说明,文案逐字照抄)
       2) Local Port Forwarding — Set the local port and binding address:
          `Local port number *` + `Bind address`(占位符 0.0.0.0)
       3) Intermediate host — This device is used as an intermediate host to access the remote host.
          `Select a host`
       4) Destination host — …where the intermediate host will direct the traffic.
          `Destination address *` + `Destination port number *`
   注:Dynamic 的说明原文写的是 "turns Termius into a SOCKS proxy server",此处按本产品名替换为 sshkit,
      其余文案原样保留。 */

const KIND_LABEL: Record<ForwardKind, string> = { local: "Local", remote: "Remote", dynamic: "Dynamic" };

const KIND_DESC: Record<ForwardKind, string> = {
  local: "Local forwarding lets you access a remote server's listening port as though it were local.",
  remote: "Remote forwarding opens a port on the remote machine and forwards connections to the local (current) host.",
  dynamic: "Dynamic port forwarding turns sshkit into a SOCKS proxy server. SOCKS proxy server is a protocol to request any connection via a remote host.",
};

export interface FwdView {
  el: HTMLElement;
  onShow: () => void;
}

interface HostLite { id: string; name: string; username: string; host: string; authType: string }

export function createFwdView(): FwdView {
  const root = document.createElement("div");
  root.className = "fwd";
  root.innerHTML = `
    <div class="fwd-bar">
      <div class="fwd-new">
        <button class="fwd-new-main">＋ New forwarding</button>
        <button class="fwd-new-caret" title="More">⌄</button>
      </div>
      <span style="flex:1"></span>
      <button class="fwd-icon" title="Search">🔍</button>
      <button class="fwd-icon" title="View">▦</button>
      <button class="fwd-icon" title="Panel">▤</button>
    </div>
    <div class="fwd-body"></div>`;
  const body = root.querySelector(".fwd-body")! as HTMLElement;

  let rules: ForwardRule[] = [];
  let statuses = new Map<string, ForwardStatus>();
  let hosts: HostLite[] = [];

  const statusOf = (id: string): ForwardStatus => statuses.get(id) ?? { id, state: "stopped", active: 0, total: 0 };

  function render(): void {
    if (!rules.length) {
      body.innerHTML = `
        <div class="fwd-empty">
          <div class="fwd-empty-ico">⇥</div>
          <h3>Set up port forwarding</h3>
          <p>Save port forwarding to access databases, web apps, and other services.</p>
        </div>`;
      return;
    }
    const list = document.createElement("div");
    list.className = "fwd-list";
    for (const r of rules) {
      const st = statusOf(r.id);
      const host = hosts.find((h) => h.id === r.hostId);
      const row = document.createElement("div");
      row.className = "fwd-row";
      const badge = document.createElement("span");
      badge.className = `fwd-badge ${r.kind}`;
      badge.textContent = KIND_LABEL[r.kind][0];
      const main = document.createElement("div");
      main.className = "fwd-main";
      const title = document.createElement("div");
      title.className = "fwd-title";
      title.textContent = r.label || `${KIND_LABEL[r.kind]} ${r.port}`;
      const sub = document.createElement("div");
      sub.className = "fwd-sub";
      sub.textContent = r.kind === "dynamic"
        ? `SOCKS5 ${r.bindAddress}:${r.port} via ${host?.name ?? r.hostId}`
        : `${r.bindAddress}:${st.boundPort ?? r.port} → ${r.destinationAddress}:${r.destinationPort} via ${host?.name ?? r.hostId}`;
      main.append(title, sub);

      const state = document.createElement("span");
      state.className = `fwd-state ${st.state}`;
      state.textContent = st.state === "running" ? `running · ${st.active} conn` : st.state === "error" ? `error: ${st.error ?? ""}` : st.state;

      const editBtn = document.createElement("button");
      editBtn.className = "btn";
      editBtn.textContent = "Edit";
      editBtn.dataset.ruleId = r.id;
      editBtn.disabled = st.state === "running" || st.state === "starting"; // 运行中改端口没有意义
      editBtn.title = editBtn.disabled ? "Stop the rule before editing" : "Edit rule";
      editBtn.addEventListener("click", () => openWizard(r));

      const toggle = document.createElement("button");
      toggle.className = "btn";
      toggle.textContent = st.state === "running" || st.state === "starting" ? "Stop" : "Start";
      toggle.addEventListener("click", async () => {
        if (st.state === "running" || st.state === "starting") await bridge.fwd.stop(r.id);
        else await bridge.fwd.start(r);
        await refresh();
      });

      const del = document.createElement("button");
      del.className = "btn danger";
      del.textContent = "✕";
      del.title = "Delete";
      del.addEventListener("click", async () => { rules = await bridge.fwd.remove(r.id); await refresh(); });

      row.append(badge, main, state, editBtn, toggle, del);
      list.append(row);
    }
    body.replaceChildren(list);
  }

  async function refresh(): Promise<void> {
    const [rs, ss] = await Promise.all([bridge.fwd.rules(), bridge.fwd.statuses()]);
    rules = rs;
    statuses = new Map(ss.map((s) => [s.id, s]));
    render();
  }

  /* ---------- 向导 ---------- */

  /** 新建与编辑复用同一套向导(原版也是同一向导、不同入口)。
      传 edit 即进入编辑态:字段预填,保存时沿用原 id(原地更新而非新增)。 */
  function openWizard(edit?: ForwardRule): void {
    const draft = {
      kind: (edit?.kind ?? "local") as ForwardKind,
      port: edit?.port ?? 0,
      bindAddress: edit?.bindAddress ?? "0.0.0.0",
      hostId: edit?.hostId ?? "",
      destinationAddress: edit?.destinationAddress ?? "",
      destinationPort: edit?.destinationPort ?? 0,
    };
    const editing = !!edit;
    let step = 1;

    const back = document.createElement("div");
    back.className = "fwd-wiz-backdrop";
    back.innerHTML = `<div class="fwd-wiz">
        <div class="fwd-wiz-head"><span class="crumb"></span><span style="flex:1"></span>
          <button class="btn wiz-skip">Skip wizard</button></div>
        <div class="fwd-wiz-body"></div>
        <div class="fwd-wiz-foot"><button class="btn wiz-back">Back</button><span style="flex:1"></span>
          <button class="btn primary wiz-next">Continue</button></div>
      </div>`;
    document.body.append(back);

    const crumb = back.querySelector(".crumb")! as HTMLElement;
    const bodyEl = back.querySelector(".fwd-wiz-body")! as HTMLElement;
    const btnBack = back.querySelector(".wiz-back")! as HTMLButtonElement;
    const btnNext = back.querySelector(".wiz-next")! as HTMLButtonElement;
    const btnSkip = back.querySelector(".wiz-skip")! as HTMLButtonElement;

    const close = (): void => back.remove();
    btnSkip.addEventListener("click", () => { close(); finish(); });
    const finish = (): void => { void refresh(); };

    function field(label: string, placeholder: string, required: boolean, get: () => string, set: (v: string) => void, slug = ""): HTMLElement {
      const wrap = document.createElement("label");
      wrap.className = "fwd-field";
      const cap = document.createElement("span");
      cap.className = "cap";
      cap.textContent = required ? `${label} *` : label;
      const input = document.createElement("input");
      input.placeholder = placeholder;
      if (slug) input.dataset.f = slug; // 便于对照台确定性地驱动向导
      input.value = get();
      input.spellcheck = false;
      input.addEventListener("input", () => set(input.value));
      wrap.append(cap, input);
      return wrap;
    }

    function draw(): void {
      btnBack.disabled = step === 1;
      btnNext.textContent = step === 4 ? "Save" : "Continue";
      crumb.textContent = step === 1
        ? (editing ? "Edit rule" : "Port Forwarding")
        : `${KIND_LABEL[draft.kind]} Rule${editing ? " · editing" : ""}`;
      bodyEl.replaceChildren();

      const title = (t: string): void => {
        const h = document.createElement("h3");
        h.textContent = t;
        bodyEl.append(h);
      };
      const hint = (t: string): void => {
        const p = document.createElement("p");
        p.className = "fwd-hint";
        p.textContent = t;
        bodyEl.append(p);
      };

      if (step === 1) {
        title("New Port Forwarding");
        hint("Select the port forwarding type:");
        const group = document.createElement("div");
        group.className = "fwd-kinds";
        for (const k of ["local", "remote", "dynamic"] as ForwardKind[]) {
          const b = document.createElement("button");
          b.className = `fwd-kind${draft.kind === k ? " on" : ""}`;
          b.innerHTML = `<span class="k">${KIND_LABEL[k][0]}</span><span class="n">${KIND_LABEL[k]}</span>`;
          b.addEventListener("click", () => { draft.kind = k; draw(); });
          group.append(b);
        }
        bodyEl.append(group);
        hint(KIND_DESC[draft.kind]);
        return;
      }

      if (step === 2) {
        const isRemote = draft.kind === "remote";
        title(isRemote ? "Remote Port Forwarding" : draft.kind === "dynamic" ? "Dynamic Port Forwarding" : "Local Port Forwarding");
        hint(isRemote
          ? "Set the remote port and binding address: This port will be open on the remote machine."
          : draft.kind === "dynamic"
            ? "Set the local port and binding address: This port will run the SOCKS proxy."
            : "Set the local port and binding address: This port will be open on the local (current) machine to forward traffic to the remote host.");
        bodyEl.append(
          field(isRemote ? "Remote port number" : "Local port number", "", true, () => draft.port ? String(draft.port) : "", (v) => { draft.port = Number(v) || 0; }, "port"),
          field("Bind address", "0.0.0.0", false, () => draft.bindAddress, (v) => { draft.bindAddress = v; }, "bind"),
        );
        return;
      }

      if (step === 3) {
        title("Intermediate host");
        hint("This device is used as an intermediate host to access the remote host.");
        const btn = document.createElement("button");
        btn.className = "btn";
        btn.textContent = draft.hostId ? (hosts.find((h) => h.id === draft.hostId)?.name ?? "Select a host") : "Select a host";
        btn.addEventListener("click", () => {
          const menu = document.createElement("div");
          menu.className = "fwd-hostmenu";
          const vault = document.createElement("div");
          vault.className = "fwd-hostgroup";
          vault.textContent = "Personal vault";
          menu.append(vault);
          for (const h of hosts) {
            const item = document.createElement("button");
            item.className = "fwd-hostitem";
            item.innerHTML = `<span class="hn"></span><span class="hs"></span>`;
            (item.querySelector(".hn")! as HTMLElement).textContent = h.name;
            (item.querySelector(".hs")! as HTMLElement).textContent = `${h.authType === "key" ? "ssh, key" : "ssh"}, ${h.username}`;
            item.addEventListener("click", () => { draft.hostId = h.id; menu.remove(); draw(); });
            menu.append(item);
          }
          bodyEl.append(menu);
        });
        bodyEl.append(btn);
        return;
      }

      title("Destination host");
      hint("IP address/hostname and the port number of the remote host where the intermediate host will direct the traffic.");
      bodyEl.append(
        field("Destination address", "", true, () => draft.destinationAddress, (v) => { draft.destinationAddress = v; }, "dest"),
        field("Destination port number", "", true, () => draft.destinationPort ? String(draft.destinationPort) : "", (v) => { draft.destinationPort = Number(v) || 0; }, "destport"),
      );
    }

    btnBack.addEventListener("click", () => { if (step > 1) { step--; draw(); } });
    btnNext.addEventListener("click", async () => {
      // 必填校验(原版:未填必填项时 Continue 不前进)
      if (step === 2 && !draft.port) return;
      if (step === 3 && !draft.hostId) return;
      if (step === 4) {
        if (!draft.destinationAddress || !draft.destinationPort) return;
        const rule: ForwardRule = {
          id: edit?.id ?? `f_${Date.now().toString(36)}`,
          hostId: draft.hostId,
          kind: draft.kind,
          bindAddress: draft.bindAddress || "0.0.0.0",
          port: draft.port,
          destinationAddress: draft.destinationAddress,
          destinationPort: draft.destinationPort,
          label: edit?.label,   // 编辑时保留自定义名
        };
        await bridge.fwd.save(rule);
        close();
        await refresh();
        return;
      }
      step++;
      draw();
    });

    draw();
  }

  root.querySelector(".fwd-new-main")!.addEventListener("click", () => openWizard());
  root.querySelector(".fwd-new-caret")!.addEventListener("click", () => openWizard());

  bridge.fwd.onStatus((s) => {
    statuses.set(s.id, s);
    render();
  });

  return {
    el: root,
    onShow: () => {
      void (async () => {
        hosts = (await bridge.hosts.list()) as unknown as HostLite[];
        await refresh();
      })();
    },
  };
}
