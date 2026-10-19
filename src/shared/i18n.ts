/* 中英文多语言。
 *
 * 约定(与原来的实现保持一致):
 *   - 产品名词不翻译(`Vaults` / `SFTP` / `Snippets` / `Port Forwarding` 的英文名沿用),
 *     只翻译界面动词、标签、提示与错误;
 *   - 键按区域分组:`rail.*` 侧栏、`toolbar.*` 工具条、`sftp.*` 双栏、`toast.*` 提示、
 *     `prefs.*` 外观面板、`term.*` 终端;
 *   - 主进程与渲染进程共用这一张表(main / renderer 各自打包,但都 import 这里),
 *     避免两边文案各写一份、切语言时对不上。
 *
 * 关键约束:**英文是基准表**(键集合由 en 决定),zh 必须是它的完整映射,
 * 缺键会在启动时由 `audit()` 报出来,而不是静默回退成英文。
 */

export type Locale = "en" | "zh";
export type LocalePref = "system" | Locale;

/** 基准表:键集合以它为准。 */
export const en = {
  /* ---- 侧栏 ---- */
  "rail.hosts": "Hosts",
  "rail.keychain": "Keychain",
  "rail.forwarding": "Port Forwarding",
  "rail.snippets": "Snippets",
  "rail.knownhosts": "Known Hosts",
  "rail.logs": "Logs",

  /* ---- 顶部栏 / 工具条 ---- */
  "top.newTab": "New Tab (⌘T)",
  "top.panel": "Terminal side-panel (⌘.)",
  "top.notifications": "Notifications",
  "top.workspaceView": "Workspace view",
  "top.appearance": "Appearance — theme / font",
  "top.sftp": "SFTP browser (ssh session required)",

  "search.placeholder": "Find a host or ssh user@hostname...",
  "search.connect": "Connect",

  "toolbar.newHost": "New host",
  "toolbar.newHostOptions": "New host options",
  "toolbar.terminal": "Terminal",
  "toolbar.serial": "Serial",
  "toolbar.tags": "Filter and sort",
  "toolbar.layout": "Change layout",
  "toolbar.appearance": "Appearance — theme / font",
  "toolbar.account": "Account",
  "toolbar.addAccount": "Add account",

  /* ---- 终端侧栏 ---- */
  "panel.terminal": "Terminal",
  "panel.jumpTo": "Jump to",
  "panel.snippets": "Snippets",
  "panel.snipName": "Name",
  "panel.snipCommand": "Command",
  "panel.save": "Save",
  "panel.hide": "Hide side-panel",

  /* ---- SFTP 双栏 ---- */
  "sftp.local": "Local",
  "sftp.remote": "Remote",
  "sftp.filter": "Filter",
  "sftp.actions": "Actions",
  "sftp.filterBy": "Filter by name",
  "sftp.colName": "Name",
  "sftp.colDate": "Date Modified",
  "sftp.colSize": "Size",
  "sftp.colKind": "Kind",
  "sftp.up": "Up",
  "sftp.reload": "Reload",
  "sftp.emptyTitle": "Connect to host",
  "sftp.emptyDesc": "Start by connecting to a saved host\nto manage your files with SFTP.",
  "sftp.emptySelect": "Select host",
  "sftp.errTitle": "SFTP unavailable",
  "sftp.errRetry": "Retry",
  "sftp.noSession": "No session available yet — connect a host from the host list first",
  "sftp.chooseSession": "Select the session to bind",
  "sftp.notBound": "Remote pane is not bound to a session",
  "sftp.pickFirst": "Select a file first (folder transfer is not supported yet)",
  "sftp.deleted": "Deleted {done}/{total} items",

  /* ---- 外观面板 ---- */
  "prefs.interface": "Interface",
  "prefs.theme": "Terminal theme",
  "prefs.fontSize": "Font size",
  "prefs.font": "Font",
  "prefs.language": "Language",
  "prefs.langSystem": "Follow system",
  "prefs.dark": "Dark",
  "prefs.light": "Light",
  "prefs.reset": "Reset",

  /* ---- 提示 / 错误 ---- */
  "toast.oneVault": "Switching vaults: only one local vault for now",
  "toast.notImplemented": "Not implemented",
  "toast.featureNotImplemented": "\"{name}\" is not implemented yet",
  "toast.serialUnsupported": "Serial is not supported: it needs a native serial dependency and a real device",
  "toast.splitFirst": "Split horizontally before turning on broadcast",
  "toast.shellHistory": "Shell History needs per-session recording; not supported yet",
  "toast.noActiveSession": "No active session to send to",
  "toast.sentTo": "Sent to {target}",
  "toast.keyNew": "New key: importing a private key is enough; not wired up yet",
  "toast.certUnsupported": "Certificate: not supported yet",
  "toast.touchId": "Touch ID needs system biometric authorization; not wired up yet",
  "toast.fido2": "FIDO2 needs a hardware key; not wired up yet",
  "term.connectFailed": "Connection failed: {msg}",

  /* ---- 主机表单 ---- */
  "form.newHost": "New host",
  "form.editHost": "Edit {name}",
  "form.name": "Name",
  "form.group": "Group",
  "form.tags": "Tags",
  "form.tagsHint": "prod, db (comma separated)",
  "form.host": "Host",
  "form.port": "Port",
  "form.username": "Username",
  "form.auth": "Auth",
  "form.password": "Password",
  "form.privateKey": "Private key",
  "form.sshAgent": "SSH agent",
  "form.keyPath": "Key path",
  "form.passwordSaved": "Password (saved in Keychain)",
  "form.keyPassphrase": "Key passphrase (optional, Keychain)",
  "form.cancel": "Cancel",
  "form.save": "Save",

  /* ---- 菜单 / 常用动作 ---- */
  "menu.reconnect": "Reconnect",
  "menu.rename": "Rename",
  "menu.duplicate": "Duplicate",
  "menu.duplicateWindow": "Duplicate in a new window",
  "menu.splitH": "Split horizontally",
  "menu.multiplayer": "Start multiplayer",
  "menu.close": "Close",
  "menu.delete": "Delete",
  "menu.closePane": "Close pane",
  "menu.closeTab": "Close Tab (⌘W)",
  "menu.connect": "Connect",

  /* ---- 分区屏 ---- */
  "sec.newSnippet": "New snippet",
  "sec.shellHistory": "Shell History",
  "sec.import": "Import",
  "empty.snippetTitle": "Create snippet",
  "empty.snippetDesc": "Save your most used commands as snippets to reuse them in one click.",
  "empty.keyTitle": "Add credentials",
  "empty.keyDesc": "Store your credentials to quick and securely access your servers.",
  "empty.logsTitle": "No logs yet",
  "empty.logsDesc": "Connection and disconnect events will appear here.",
  "chip.newKey": "New key",
  "chip.certificate": "Certificate",
  "chip.touchId": "Touch ID",
  "chip.fido2": "FIDO2",

  /* ---- 弹窗 ---- */
  "dlg.discardTitle": "Do you want to discard changes?",
  "dlg.discardDesc": "Not all required fields are filled. Do you want to finish editing and discard all changes?",
  "dlg.discard": "Discard changes",
  "dlg.hostKeyTitle": "Are you sure you want to connect?",
  "dlg.hostKeyDesc": "The authenticity of {host} can not be established.",
  "dlg.hostKeyFp": "{type} fingerprint is SHA256:{fp}",
  "dlg.hostKeyAsk": "Do you want to add it to the list of known hosts?",
  "dlg.hostKeyChanged": "The fingerprint for {host} has changed",
  "dlg.hostKeyBreach": "This could indicate a potential security breach.",
  "dlg.continue": "Continue",
  "dlg.addContinue": "Add and continue",
  "dlg.replace": "Replace",
  "dlg.addAsNew": "Add as new",
  "dlg.closeOnly": "Close",

  /* ---- 其它 ---- */
  "kh.note": "Read from ~/.ssh/known_hosts (shared with system ssh)",
  "err.sshUnavailable": "SSH session is not available",
  "sftp.kindFolder": "folder",
  "sftp.kindFile": "file",
  "err.ptyMissing": "Process not found (the pty is gone)",
  "err.readFile": "Could not read the selected file: {msg}",
  "term.exitNormal": "Remote shell exited normally",
  "term.disconnected": "Connection lost",
} as const;

export type MsgKey = keyof typeof en;

/** 中文映射:必须覆盖 en 的全部键(audit() 会检查)。 */
export const zh: Record<MsgKey, string> = {
  "rail.hosts": "主机",
  "rail.keychain": "钥匙串",
  "rail.forwarding": "端口转发",
  "rail.snippets": "代码片段",
  "rail.knownhosts": "已知主机",
  "rail.logs": "日志",

  "top.newTab": "新建标签页(⌘T)",
  "top.panel": "终端侧栏(⌘.)",
  "top.notifications": "通知",
  "top.workspaceView": "工作区视图",
  "top.appearance": "外观 — 主题 / 字体",
  "top.sftp": "SFTP 浏览器(需 ssh 会话)",

  "search.placeholder": "查找主机,或输入 ssh 用户@主机名…",
  "search.connect": "连接",

  "toolbar.newHost": "新建主机",
  "toolbar.newHostOptions": "新建主机选项",
  "toolbar.terminal": "终端",
  "toolbar.serial": "串口",
  "toolbar.tags": "筛选与排序",
  "toolbar.layout": "切换布局",
  "toolbar.appearance": "外观 — 主题 / 字体",
  "toolbar.account": "账户",
  "toolbar.addAccount": "添加账户",

  "panel.terminal": "终端",
  "panel.jumpTo": "跳转到",
  "panel.snippets": "代码片段",
  "panel.snipName": "名称",
  "panel.snipCommand": "命令",
  "panel.save": "保存",
  "panel.hide": "隐藏侧栏",

  "sftp.local": "本地",
  "sftp.remote": "远端",
  "sftp.filter": "筛选",
  "sftp.actions": "操作",
  "sftp.filterBy": "按名称筛选",
  "sftp.colName": "名称",
  "sftp.colDate": "修改日期",
  "sftp.colSize": "大小",
  "sftp.colKind": "类型",
  "sftp.up": "上级",
  "sftp.reload": "刷新",
  "sftp.emptyTitle": "连接主机",
  "sftp.emptyDesc": "先连接一台已保存的主机,\n即可用 SFTP 管理文件。",
  "sftp.emptySelect": "选择主机",
  "sftp.errTitle": "SFTP 不可用",
  "sftp.errRetry": "重试",
  "sftp.noSession": "还没有可用会话 —— 先从左侧主机列表连接一台主机",
  "sftp.chooseSession": "选择要绑定的会话",
  "sftp.notBound": "远端尚未绑定会话",
  "sftp.pickFirst": "先选中一个文件(暂不支持目录传输)",
  "sftp.deleted": "已删除 {done}/{total} 项",

  "prefs.interface": "界面",
  "prefs.theme": "终端主题",
  "prefs.fontSize": "字号",
  "prefs.font": "字体",
  "prefs.language": "语言",
  "prefs.langSystem": "跟随系统",
  "prefs.dark": "深色",
  "prefs.light": "浅色",
  "prefs.reset": "重置",

  "toast.oneVault": "切换保管库:目前只有一个本地保管库",
  "toast.notImplemented": "尚未实现",
  "toast.featureNotImplemented": "「{name}」尚未实现",
  "toast.serialUnsupported": "暂不支持串口:需要串口原生依赖与真实设备",
  "toast.splitFirst": "先 Split horizontally 再开启广播",
  "toast.shellHistory": "Shell History 需要按会话记录历史,暂未支持",
  "toast.noActiveSession": "没有活动会话可发送",
  "toast.sentTo": "已发送到 {target}",
  "toast.keyNew": "New key:支持导入私钥即可,暂未接入",
  "toast.certUnsupported": "Certificate:暂未支持",
  "toast.touchId": "Touch ID:需要系统生物识别授权,暂未接入",
  "toast.fido2": "FIDO2:需要硬件密钥,暂未接入",
  "term.connectFailed": "连接失败:{msg}",

  "form.newHost": "新建主机",
  "form.editHost": "编辑 {name}",
  "form.name": "名称",
  "form.group": "分组",
  "form.tags": "标签",
  "form.tagsHint": "prod, db(逗号分隔)",
  "form.host": "主机",
  "form.port": "端口",
  "form.username": "用户名",
  "form.auth": "认证方式",
  "form.password": "密码",
  "form.privateKey": "私钥",
  "form.sshAgent": "SSH 代理",
  "form.keyPath": "私钥路径",
  "form.passwordSaved": "密码(存于钥匙串)",
  "form.keyPassphrase": "私钥口令(可选,存于钥匙串)",
  "form.cancel": "取消",
  "form.save": "保存",

  "menu.reconnect": "重新连接",
  "menu.rename": "重命名",
  "menu.duplicate": "复制标签页",
  "menu.duplicateWindow": "在新窗口复制",
  "menu.splitH": "水平分屏",
  "menu.multiplayer": "开始多人协作",
  "menu.close": "关闭",
  "menu.delete": "删除",
  "menu.closePane": "关闭窗格",
  "menu.closeTab": "关闭标签页(⌘W)",
  "menu.connect": "连接",

  "sec.newSnippet": "新建片段",
  "sec.shellHistory": "Shell 历史",
  "sec.import": "导入",
  "empty.snippetTitle": "创建代码片段",
  "empty.snippetDesc": "把常用命令存成片段,一键复用。",
  "empty.keyTitle": "添加凭据",
  "empty.keyDesc": "保存凭据,以便快速、安全地访问服务器。",
  "empty.logsTitle": "暂无日志",
  "empty.logsDesc": "连接与断开事件会显示在这里。",
  "chip.newKey": "新建密钥",
  "chip.certificate": "证书",
  "chip.touchId": "触控 ID",
  "chip.fido2": "FIDO2",

  "dlg.discardTitle": "要放弃这些修改吗?",
  "dlg.discardDesc": "必填项还没填完。要结束编辑并放弃所有修改吗?",
  "dlg.discard": "放弃修改",
  "dlg.hostKeyTitle": "确定要连接吗?",
  "dlg.hostKeyDesc": "无法确认 {host} 的真实性。",
  "dlg.hostKeyFp": "{type} 指纹为 SHA256:{fp}",
  "dlg.hostKeyAsk": "要把它加入已知主机列表吗?",
  "dlg.hostKeyChanged": "{host} 的指纹已变更",
  "dlg.hostKeyBreach": "这可能意味着存在安全风险。",
  "dlg.continue": "继续",
  "dlg.addContinue": "添加并继续",
  "dlg.replace": "替换",
  "dlg.addAsNew": "作为新条目添加",
  "dlg.closeOnly": "关闭",

  "kh.note": "读取自 ~/.ssh/known_hosts(与系统 ssh 共用)",
  "err.sshUnavailable": "ssh 会话不可用",
  "sftp.kindFolder": "文件夹",
  "sftp.kindFile": "文件",
  "err.ptyMissing": "找不到该进程(pty 已消失)",
  "err.readFile": "无法读取所选文件:{msg}",
  "term.exitNormal": "远端 shell 正常退出",
  "term.disconnected": "连接断了",
};

const catalogs: Record<Locale, Record<string, string>> = { en, zh };

let current: Locale = "en";

/** 由系统语言偏好与用户设置解出真正生效的语言 */
export function resolveLocale(pref: LocalePref, systemLang: string): Locale {
  if (pref === "zh" || pref === "en") return pref;
  return /^zh\b/i.test(systemLang) ? "zh" : "en";
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }
}

/** 取一条文案,`{name}` 占位替换;缺键时返回键名本身(便于发现漏配) */
export function tr(key: MsgKey, vars?: Record<string, string | number>): string {
  const table = catalogs[current] ?? en;
  let msg = table[key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) msg = msg.split(`{${k}}`).join(String(v));
  }
  return msg;
}

export type TranslateAttrs = {
  /** 文本内容 */
  text?: string;
  /** placeholder */
  placeholder?: string;
  /** title */
  title?: string;
  /** aria-label */
  aria?: string;
};

/**
 * 把一棵 DOM 子树里带 `data-i18n*` 的静态标记就地翻译。
 * 支持:data-i18n(文本)、data-i18n-placeholder、data-i18n-title、data-i18n-aria。
 * 渲染层每次切换语言后调用一次即可;纯静态文案不必进 JS。
 */
export function applyDom(root: ParentNode = document as unknown as ParentNode): void {
  if (typeof document === "undefined") return;
  const scan = (el: Element): void => {
    const text = el.getAttribute("data-i18n");
    if (text) el.textContent = tr(text as MsgKey);
    const ph = el.getAttribute("data-i18n-placeholder");
    if (ph) (el as HTMLInputElement).placeholder = tr(ph as MsgKey);
    const ti = el.getAttribute("data-i18n-title");
    if (ti) el.setAttribute("title", tr(ti as MsgKey));
    const ar = el.getAttribute("data-i18n-aria");
    if (ar) el.setAttribute("aria-label", tr(ar as MsgKey));
  };
  /* document 本身不是 Element,不能直接 getAttribute —— 早期版本在这里抛错,
     异常被调用方的 try/catch 吞掉,表现为"语言已切换但界面不翻译" */
  if (root instanceof Element) scan(root);
  root.querySelectorAll?.("[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria]")
    .forEach(scan);
}

/** 自检:返回 zh 相对 en 缺失的键(启动时若不为空会在控制台报出来) */
export function audit(): string[] {
  return Object.keys(en).filter((k) => !(k in zh) || !zh[k as MsgKey]);
}

/** 语言选择器的候选(值 → 展示名);"跟随系统"由界面单独呈现 */
export const LOCALE_OPTIONS: ReadonlyArray<{ value: LocalePref; label: string }> = [
  { value: "system", label: "system" },
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
];
