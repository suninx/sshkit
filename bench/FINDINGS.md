# 对照台实测记录(bench/FINDINGS.md)

> 每条都要有证据路径。写法见 `PROTOCOL.md` §6。
> 本次会话:2026-10-17 12:20–12:50 CST,机器 macOS 26.2(25C56),屏 3440×1440。

---

### F1 原版停在登录墙,功能对照被它卡住                    [2026-10-17 12:45]
- 问题:原版起来后能不能直接做终端/SFTP/转发对照?
- 动作:`bash bench/up.sh` → `node bench/grab.mjs --port 9222 --url-match primary`
- 证据:`bench/sessions/2026-10-17_124556-first-look/01-termius-primary.png`
- 结果:原版渲染的是 **"Welcome to Termius — Unlock AI-powered tools, Sync, and Collaboration"** 登录页
  (Continue with Google / Apple / email + Log in)。**进不到终端界面**。
- 影响:**A 的下一步(逐特性行为对照)需要你先把原版登录一次**(只有你能做,涉及你的账号)。
  登录后原版的本地主机簿/终端才可用。若 Termius 10.2.1 有"跳过登录/离线使用"入口,也请告诉我。

### F2 原版"打不开"的真因是环境变量,不是它坏了             [2026-10-17 12:31]
- 问题:原版 `payload/Termius.app` 双击/open/直启都秒退(exit 0,无输出)。
- 证据:`env | grep ELECTRON_RUN_AS_NODE` → `=1`(全局导出);直启输出 `bad option: --remote-debugging-port=9222`;
  `~/Library/Application Support/Termius` 从未被创建。
- 结果:`ELECTRON_RUN_AS_NODE=1` 让 Electron 以纯 Node 跑 main.js → 原版自检后静默退出;
  `env -u ELECTRON_RUN_AS_NODE` 后**原版正常启动**。
- 影响:`up.sh`/`down.sh` 一律在子进程清除该变量。**手工起任何 Electron 应用都要注意。**

### F3 排除性证据:原版二进制完好,别再从"被改坏"方向查      [2026-10-17 12:33]
- 证据:DMG 与 payload 的 `app.asar` 逐字节一致 `b9d10de84225dc6f29a3e824344923896134056cb58692c45337fb7b7ef83c04`
  (与 `termius-rea/docs/analysis-notes.md:11` 同值);`codesign --verify` 通过;Gatekeeper
  `accepted / source=Notarized Developer ID / Termius Corporation (6KN952WR85)`。
- 结果:签名、公证、包内容均正常 → F2 之外无"包被改坏"问题。
- 影响:省掉一整轮错误排查方向。

### F4 原版 CDP 可用,并顺带暴露它的三进程结构               [2026-10-17 12:38]
- 动作:`Termius --remote-debugging-port=9222`(清掉 F2 的变量后)
- 证据:`/json/version` → `Termius/10.2.1 Chrome/150.0.7871.250 Electron/43.5.1`;
  `/json/list` → **3 个 page target**
- 结果:三个 target 的 URL 直接给出架构分层:
  `ui-process/src/ui-process/main.html?type=primary` · `ui-process/src/settings-process/main.html?type=preferences`
  · `background-process/src/background-process/main.html`
- 影响:①证据主通道成立(PROTOCOL §1 E1);②"UI / 设置 / 后台"三分层是 M3+ 架构对照的第一手参照;
  ③我们只有单 renderer,进程拓扑差异是结构性差异(T8 相关)。

### F5 REA 的 web 截图工具吃不下 file:// 目标                [2026-10-17 12:41]
- 证据:`capture_web_screenshot` 对 9222/9223 两侧均返回
  `{"reason":"target_not_allowed","code":"target_unavailable"}`
- 结果:REA 按 http/https 源做策略,Electron 的 `file://` 页不在其内。
- 影响:自建 `bench/grab.mjs`(直连各 target 的 `webSocketDebuggerUrl`,Node 22 内置 WebSocket,零依赖)。
  `inspect_electron_page` 这类 Electron 专用工具是否可用于结构性对照,待试。

### F6 CDP 能读窗口几何、不能移动窗口                        [2026-10-17 12:42]
- 证据:`Browser.getWindowForTarget` → `'wasn't found (code -32601)'`(两侧皆然);
  `Runtime.evaluate('screenX/screenY/outerWidth/outerHeight')` → 原版 `1280x800 @ (1080,256)`,sshkit `1080x700 @ (1180,370)`
- 结果:Electron 未实现 Browser 域的窗口方法。
- 影响:摆位改成"sshkit 侧 `SSHKIT_BENCH_BOUNDS` 自摆 + 读原版几何自动同尺寸/紧贴"(已实现于 `up.sh`);
  原版窗口需手动拖一次。

### F7 "辅助功能"未授权;顺带修掉一个假阳性探针              [2026-10-17 12:29]
- 证据:`osascript -e 'tell application "System Events" to return (count of windows of process "Finder")'`
  → `-25211 "osascript"不允许辅助访问`
- 结果:窗口类 AppleScript 全不可用。**注意**:早先 preflight 用 `frontmost` 探针**误报可用**——
  那个调用不需要辅助功能。已改为"查进程窗口数"这种真 UI 查询。
- 影响:preflight 现在如实报告;不给授权也不阻塞(PROTOCOL §3.3)。

### F8 screencapture 会瞬时失败,不能写死依赖                [2026-10-17 12:22 / 12:27]
- 证据:12:22 `screencapture -x` → `could not create image from display`(无文件);12:27 同机同参数
  → 成功 3440×1440;`-R 0,25,1720,1415` → 精确 1720×1415。
- 结果:非授权问题,是显示器睡眠/锁屏态导致。
- 影响:screencapture 仅作兜底(PROTOCOL §1 E2),主通道用 CDP;脚本失败要显式报错而非产出空证据。

### F9 HANDOVER §7 记错了:三块 M2.5/M3 需求在蓝图里不存在   [2026-10-17 12:24]
- 问题:§7 称"端口转发、快捷键、多 Tab 的对照细节均在那里(blueprints)"。
- 证据:对 `termius-rea/docs/blueprints/*.md` 全量检索
  `forward|转发|隧道|tunnel|proxy|jump|socks|tab|快捷键|keybind|accelerator` → **0 命中**;
  `06-ui.md` 实际只写"命令词典 / React 层 / 词典残留"。
- 结果:三项**无需求文档**,只有零散原料(位置见 PROTOCOL §5:T2/T3/T4 行)。
- 影响:选项 C 的真实第一步是"测出规格 + 补蓝图",不是写代码。这正是本对照台要产出的东西。

### F10 首屏几何与信息密度差异(可量化的对照起点)           [2026-10-17 12:45]
- 证据:同一次会话的两张 E1 PNG(见 F1 目录)
- 结果:原版窗口 1280×800(内高 800,无独立标题栏占用);sshkit 窗口 1280×800 时内高 768
  (差 32px,标题栏/边框计入方式不同)。sshkit 首屏 = 左栏(主机簿:Local shell + `node-1 root@192.0.2.10`)
  + 终端页(`local shell` 标签、可用 zsh 提示符)+ 右上 SFTP 按钮;原版首屏 = 登录页。
- 影响:窗口内高差会让"同尺寸截图"仍有 32px 错位,做像素级 diff 前要先对齐内高(记进 T1)。

### F11 登录后首屏对照:UI 骨架差异(含 T2/T3 的落点)        [2026-10-17 12:56]
- 动作:`node bench/grab.mjs --port 9222 --eval-file bench/probes/ui-skeleton.js`(sshkit 侧同款探针换 `--port 9223`)
- 证据:`bench/sessions/2026-10-17_125646-post-login/`(`01-*.png` 首屏、`02-*-skeleton.json` 骨架)
- 结果(实测数字,非目测):

  | 维度 | 原版 10.2.1 | sshkit |
  |---|---|---|
  | DOM 节点 | **322** | 169 |
  | `button` | 19 | 17 |
  | `input/textarea` | **2** | 10 |
  | `data-testid` | **3**(`menu-button`/`horizontal-tabs`/`new-tab-button`) | **0** |
  | 内联 `svg` 图标 | **21** | 0(用 `＋ ✎ ✕ ⇄` 字符) |
  | 正文色 / 底色 | `rgb(20,23,41)` / 浅色 | `rgb(216,222,233)` / `rgb(16,20,24)` 深色 |

  **一级导航(原版)**:`Hosts · Keychain · Port Forwarding · Snippets · Known Hosts · Logs`
  **顶部 tab 条(原版)**:`Vaults | SFTP | +`(`data-testid=horizontal-tabs` / `new-tab-button`)
  **原版 SFTP 是 tab,我方是右上角按钮**;原版另有 `Type "ssh user@hostname -p port" to connect...` 快速连接框,
  我方必须先存主机才能连。

- 影响(可执行):
  1. **T3 端口转发在原版是"一级导航项"** → 我们的落点不必自己发明(对照台后续点进去取规格)。
  2. **T2 多 Tab**:原版 tab 条与"SFTP 作为 tab"是现成结构参照。
  3. **主题**:原版默认浅色、我方深色 —— 06-ui 的直接差异项。
  4. 建议给 sshkit 关键控件**补 `data-testid`**:既方便将来测试,也让对照台能用同一选择器驱动两侧。
  5. 我方 10 个 input 常驻 DOM(主机表单未按需挂载),原版只有 2 个 —— 节点数与渲染策略不同。
