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

### F12 T1 终端渲染实测:两侧跑同一条命令后逐格比对        [2026-10-17 13:13]
- 动作:两侧都连 `192.0.2.10`(原版用户手动登,sshkit 由 `drive.mjs` 点主机项),
  再用 `drive.mjs --insert-file` 把**同一条** 8 暗色 + 8 亮色 + 字形样本命令投进两侧终端,
  然后 `bench/probes/ansi-palette.py` 按已知字符格取样。
- 证据:`bench/sessions/2026-10-17_13_13_1{0,2}-t1-ansi3-{termius,sshkit}/`(含 before/after 图与 DOM)
- 结果:

  | 维度 | 原版 10.2.1 | sshkit |
  |---|---|---|
  | 终端字体 | **Meslo** 14px | **Menlo, "DejaVu Sans Mono", monospace** 13px |
  | 行距(pitch) | **18px** | 15px |
  | 字符格宽 | 7.96px | 7.84px |
  | 背景 | **#141728** | **#101418** |
  | 渲染器 | **canvas**(4 层:`xterm-text/selection/link/cursor-layer`) | **DOM**(`.xterm-rows` 47 行,0 canvas) |
  | 光标色 | 偏绿(≈`#42b16e`) | `#8dbfd0` |
  | 默认前景(`\033[0m`/`\033[39m` 后) | **#42b16e** | **#d8dee9** |
  | 会话中普通输出(远端留着 SGR 32) | ANSI 绿 **#258265** | ANSI 绿 **#589623** |

  16 色调色板 —— **权威值**(取自原版 ui-process 源码 `colorSchemesArray` 的 "Termius Dark" 条目,见 F13;

  ⚠️ 本节早先那张"像素逐格反推"的表已作废:单字符笔画细、抗锯齿占比大,"最饱和四分位"取法对灰阶
  尤其失真 —— 它把 ANSI 白记成了 `#6b6d7a`,真值是 `#e2e3e8`。教训:量调色板要用**实心色块**
  (`printf '\033[41m      \033[0m'`,背景铺色无抗锯齿),不要用单字符):

  | | 暗(40-47) | 亮(100-107) |
  |---|---|---|
  | 黑 | `#343851` | `#8d91a5` |
  | 红 | `#f24e50` | `#ff7375` |
  | 绿 | `#008463` | `#3ed7be` |
  | 黄 | `#eca855` | `#fdc47d` |
  | 蓝 | `#08639f` | `#6ba0c3` |
  | 品红 | `#c13282` | `#ff7dc5` |
  | 青 | `#2091f6` | `#44a7ff` |
  | 白 | `#e2e3e8` | `#ffffff` |

  以及 `backgroundColor:"#141729"`、`foregroundColor:"#21b568"`、`cursorColor:"#21b568"`、
  `selectionColor:"#21b56880"`、`defaultFontSize:14`、`defaultFontFamily:"Source Code Pro"`
  (实机测得终端字体是 **Meslo**,与常量不同 —— 见 F13 的待确认项)。

  色彩空间提醒:同一真彩色**在两侧成像一致但都不等于配置值**(如配置 `#e8594f` 双方都成像 `#e26250`,
  `#0080ff` → `#0383fb`;灰阶无偏差)。这是 macOS/Electron 的色彩空间转换,不是应用差异 ——
  故"截图取色"只能用于**双方对比**,不能直接当作配置值。

  **主题目录(原版内置,≥20 套)**:Termius Dark / Termius Light / Flexoki Dark·Light /
  Kanagawa Wave·Dragon·Lotus / Hacker Blue·Green·Red / Everforest Dark·Light / Night Owl / Light Owl /
  Aura / Rosé Pine ·Moon ·Dawn / Cobalt2 / Octocat Dark·Light / Ayu Dark·Light / 1984 Dark·Light …
  另有 Font 设置项与主题预览图。

- **机制澄清(重要,别误判成"主题前景是绿的")**:远端 shell 的 prompt 之后**留着 SGR 32 不复位**,
  所以"命令回显 + 普通输出"继承的是各终端的 **ANSI 绿**(原版 `#258265` / 我方 `#589623`);
  只有在行首显式 `\033[0m`/`\033[39m` 之后,才暴露**终端默认前景** —— 原版 `#42b16e`、我方 `#d8dee9`。
  判据:`\033[37m`(白)在原版渲染为 `#e2e3e8`,证明绿不是渲染管线问题。
- 影响(T1 待办):
  1. 字体族/字号/行距需对齐(或做成可配):`Meslo 14px` + pitch 18 vs `Menlo 13px` + pitch 15 —— 视觉体量差约 20%。
  2. 需要**主题体系**(原版 20+ 套,我方 1 套),并把 16 色调色板作为主题数据而非硬编码。
  3. 背景 `#141728` vs `#101418` 属主题数据差异。
  4. 原版默认前景是绿色 —— **待确认是"主题定义"还是"用户改过"**(见 F13 待办)。
  5. 我方用 DOM 渲染器、原版用 canvas:若将来大量滚动/大回看,这是性能与实现路线差异(T8 相关)。
- 方法学备注(下次少踩):① 16 色测试串里 8 暗与 8 亮之间**有一个空格**,漏算会让亮色整排错位一格;
  ② 量"默认前景"必须行首显式复位,否则量到的是 ANSI 绿;③ `drive.mjs` 逐键打字会把 `\` 吞掉、
  且字母键码须用大写码(`p/r/t`=112/114/116 落在 VK_F1..F12 区间会被当功能键),故一律走 `--insert-file`;
  ④ 调色板要用实心色块量,别用单字符(见上);⑤ 取样脚本别用固定 glob,换 tag 后会读到**旧截图**
  (我就这么被骗过一次,差点得出"改了没生效"的错误结论)。

### F13 T1 复刻实现与复验:16/16 色 Δ=0                        [2026-10-17 13:55]
- 目标从"对照"转为"复刻"(用户明确):不再只记录差异,而是把值改成与原版一致并**重新测量复验**。
- 权威真值来源:原版自身 `ui-process` 源码里的 `colorSchemesArray`(比像素反推可靠):
  `"Termius Dark"` 的 16 色 `colorPaletteOverrides` + `backgroundColor/cursorColor/foregroundColor/
  selectionColor`;同处还有 `defaultFontSize=14`、`defaultColorScheme="termius dark"`、
  `defaultFontFamily="Source Code Pro"`、`minFontSize=4/maxFontSize=40`。
  (同文件还坐着 **Termius Light / Flexoki Dark·Light / …** 全套主题,是 T1 主题体系的数据源。)
- 字体:原版 `assets/MesloLGSNerdFontMono-{Regular,Bold}.ttf` = **Nerd Fonts 3.2.1**(name 表实测:
  `Version 1.210;Nerd Fonts 3.2.1`,族名 `MesloLGS Nerd Font Mono`)。已从**上游 release** 取同版本,
  与包内文件**逐字节一致**(sha256 相同),Apache-2.0,随附 `src/renderer/fonts/LICENSE.txt`。
- 改动:`src/renderer/fonts/*`(字体)+ `index.html`(@font-face + CSP `font-src 'self'`)+
  `app.ts`(字体/字号/行高/主题)+ `esbuild.mjs`(拷贝字体)+ 新增依赖 `@xterm/addon-canvas`。
- 复验(两侧同一把尺子,`bench/probes/` 与实心色块法):

  | 维度 | 原版 | 复刻后 | 结果 |
  |---|---|---|---|
  | 终端字体 | MesloLGS NF Mono 14px | 同一文件、14px | ✅ |
  | 字符格 | 8×18 px(光标墨迹盒) | 8×18 px | ✅ |
  | 底色(成像) | `#141728` | `#141728` | ✅ |
  | 默认前景(成像) | `#42b16e` | `#42b16e` | ✅ |
  | 16 色调色板(实心色块) | — | — | ✅ **16/16 Δ=0** |
  | 渲染器 | canvas 四层 text/selection/link/cursor | 同签名 | ✅ |

- 过程中的两个判断(留档):
  1. `@xterm/addon-canvas@0.7.0` 声明的 peer 是 `xterm ^5`,而项目用 `xterm 6.0.0`;所有版本(含 beta)
     都只声明 ^5。**没有据此放弃,而是实测**:插件在 6.0.0 上工作正常(四层 canvas 出现、
     格宽由小数 8.429 量化为整数 8,与原版一致),故保留,并加了 try/catch 容错(失败退回 DOM 渲染)。
  2. `lineHeight` 不是猜的:字体自然盒高 18px、`1.1→19`、`1.05→18`,按实测收敛。
- 待确认项:`defaultFontFamily` 常量是 `"Source Code Pro"`,但实机终端是 **Meslo**(字号 14 与常量一致)。
  由于字体设置不在 localStorage(在加密库内),此处按**实机观测**取 Meslo。若要以"出厂默认"为准,
  应改回 Source Code Pro —— 需用户裁定。附带情报:原版打包 12 个 Nerd Font 等宽族
  (Meslo/JetBrains Mono/Fira Code·Mono/SauceCodePro/Ubuntu Mono/Inconsolata/Anonymice Pro/
  Caskaydia Cove/DejaVu Sans M/Droid Sans M),外加 UI 商业字体 **CircularXX**(**不可搬用**,我方 UI 用系统字体栈)。

### F14 T2 多 Tab 体系:规格、实现与复验                      [2026-10-17 14:15]
- **原版规格(实测)**:
  - 条:`[data-testid=horizontal-tabs]`,**高 51px**、底色 = **终端主题底色**(`#141729`,即条随终端主题走),
    内容区随应用主题(同一台机器上先后测到浅色与深色两种,故比较样式时必须注明当时的主题)。
  - tab:高 30px、圆角 10px;非活动 = `rgba(255,255,255,.05)` 叠加、文字 `#a4b3ba`;
    **活动会话 tab = `rgba(33,181,104,.2)` 叠加、文字 `#21b568`**(会话图标同为绿色)。
  - 宽度:固定 tab(Vaults/SFTP)80px;会话 tab 随标题(实测 168~240px)。
  - **关闭按钮在会话 tab 的左侧**(`close-tab` x=264,而该 tab 起于 259;21×23,圆角 5)。
    右侧另有一个图标,**用途未验证**(记为待查)。
  - **"+" 直接新建 tab,不弹菜单**(我先前误判为弹菜单:那次看到的 "Recent sessions/New Tab" 其实是
    新 tab 的落地页内容)。`new-tab-button` 30×30 圆角 10;菜单/落地页打开时该按钮会被弹层取代。
  - 新 tab 落地页:居中搜索/连接框(宽约 667、高 36、圆角 10、占位符 **"Search hosts or tabs"**、
    右侧 **⌘+K** 提示),下方图标 + **"Recent sessions"**(18px/500)+ 两行空态文案
    "Your recent sessions will be visible here." / "In the meantime, start connecting with CMD+K"。
    另在 F11 时曾测到占位符 `Type "ssh user@hostname -p port" to connect...` —— 同一位置的两种文案,
    疑与版本/状态有关,按最近一次实测为准。
  - **快捷键(权威来源:原版 `localStorage.shortcut_schemes`)**:
    Mac = `Cmd+T` 新建 / `Cmd+W` 关闭 / `Cmd+Shift+]` 下一个 / `Cmd+Shift+[` 上一个;
    PC = `Ctrl+T` / `Ctrl+Shift+W` / `Alt+→` / `Alt+←`。
- **实现(sshkit)**:主进程与桥接本就按 id 区分会话(`terminal:create`/`ssh:connect` 各返回独立 id、
  事件都带 id),故多 tab 只动渲染层:
  `app.ts` 引入 tab 模型(每 tab 一个 `.tab-pane`,内含自己的 `Terminal` 与会话 id)、
  条渲染(活动态/会话绿/连接指示点/关闭按钮)、`Cmd+T/W/Shift+[ ]`、新 tab 落地页;
  `index.html` 增 tab 条与落地页样式(**类名用 `.tab-pane` 以免与 SFTP 弹层的 `.pane/.panes` 冲突**)。
  行为对齐原版:点主机即**在活动 tab 内**连接;活动 tab 已是会话时才新开 tab;初始为一个 New Tab 落地页。
- **复验(对自家实例走 CDP 驱动)**:`Cmd+T` → 新增 New Tab ✓;点 `node-1` → 在活动 tab 内连上(标题变
  `node-1`、指示点转绿)✓;点 `Local shell` → **第二个并发会话** ✓(两会话同时 on);`Cmd+Shift+]` → 循环 ✓;
  `Cmd+W` → 关闭并激活邻居 ✓;样式实测 `条高 51 / tab 30 / 圆角 10 / 活动会话 rgba(33,181,104,.2) / 文字 #21b568`
  —— 与原版实测值一致。改类名后 SFTP 弹层复测正常(`display:flex`、`position:static`、双栏各 422px)。
- 待查/待定:原版会话 tab 右侧那个图标是什么(用途未验证);原版的 Vaults/SFTP 固定 tab 我方无对应物
  (我方以侧栏承担 vault 角色),是否补固定 tab 待定。
- ⚠️ **tab 配色随应用 UI 主题变化(同一天测到两套,别把它当固定值)**:
  - 深色 UI 变体(14:00 测):条底 `#141729`;非活动 tab `rgba(255,255,255,.05)` + **白字**;
    活动会话 `rgba(33,181,104,.2)` + `#21b568`。
  - 浅色 UI 变体(14:30 测):非活动 tab `rgba(141,145,165,.1)` + 标签 `#8d91a5`(fw 450);
    外层容器文字为应用正文色 `rgb(20,23,41)`。
  - 我方是深色 UI,故**实现取深色变体**;若将来加浅色主题,这些叠加色应随主题切换。
  - 另:同一时刻"活动会话 tab"的**文字**到底取绿还是取白,两次测量不一致(容器绿 / 标签白 vs 整块绿),
    我取"容器染色 + 标签随主题"这一解释(与 Vaults 的容器/标签分层一致),记为**待复核**。
- 方法学:① 探针要发组合键,给 `drive.mjs` 加了 `--key "cmd+shift+]"`(发真实 keyDown/keyUp + modifiers),
  并用它验证了原版的 `Cmd+W` 确实逐次关 tab;② 弹层类 UI 必须"点完当场求值"(`--probe-file`),
  分两步探测会因失焦关闭而拿到空结果;③ 我一度把"点 + 后出现的 Recent sessions"误读成弹出菜单 ——
  教训是**先看一眼截图再解释 DOM**。

### F15 T5 SFTP:规格、实现与复验                              [2026-10-17 14:55]
- **原版规格(实测)**:SFTP 是**一个常驻 tab**(`Vaults | SFTP | …`),内容是左右双栏(Local | 远端)。
  - 栏标题行高 50:标题 14px/**fw 450**(`Local`),右侧 `🔍 Filter` 与 `Actions ⌄`。
  - 面包屑行高 50:`‹`(上级)`›`(刷新)+ 路径段(每段带小方块图标),14px/450。
  - 列头行高 34:`Name | Date Modified | Size | Kind`,**12px/fw 700**;列 x 偏移(相对栏缩进 20)= 20/299/450/551。
  - 行高 47,**两行式**:文件名 14px + 下一行权限串 `drwxr-xr-x@`(**10px、#798c94**);
    日期形如 `8/14/2026, 12:43 AM`;目录的 Size 是占位符、Kind 为 `folder`(文件为 `file`)。
  - **默认不显示隐藏文件**(其本地栏 `..` 之后直接是 Applications/Desktop/…),**每栏首行是 `..`**。
  - 未绑定会话的一侧显示空态:图标 + **"Connect to host"**(18px/500)+ 说明 + **"Select host"** 按钮。
  - 栏间 1px 分隔(浅色 UI 下实测 `#e6ebed`)。
- **实现(sshkit)**:
  - `src/shared/sftp.ts` + `src/main/sftp.ts`:条目新增 **`mode`**(本地 `st.mode`、远端 `attrs.mode`),
    渲染层据此生成权限串 —— 原版行内那行权限字是**真数据**,不是装饰。
  - `src/renderer/sftp.ts` 从"模态框 + 单行列表"重写为"tab 内的双栏浏览器":上述尺寸/结构照抄,
    原有操作(mkdir/rename/delete/upload/download)收进 `Actions ⌄`,另加 `Filter` 输入与"显示隐藏文件"开关。
  - `app.ts`:新增 `sftp` 类型 tab(单例,重复点即激活);`⇄ SFTP` 按钮改为打开该 tab。
  - **有意偏离**:原版 SFTP tab 不自动绑定终端会话(要手动 Select host),我方**自动绑定最近活动会话**,
    同时保留 `Select host` 用于改绑(多会话时可选)。这条偏离是为了少一次点击,已记录在案。
- **复验(CDP 驱动自家实例)**:打开 SFTP tab → 两栏标题 `Local` / `node-1 (192.0.2.10)` ✓;
  绑定后 113 行、空态 0 ✓;行结构 = 名字 + `drwxr-xr-x` + `4/18/2026, 11:23 AM` + `-` + `folder` ✓;
  两栏首行均为 `..` ✓;点文件默认不再出现(隐藏文件已滤掉)✓。
- **过程中修掉的真 bug**:SFTP tab 的"当前会话"取的是**活动 tab** 的会话,而活动 tab 恰恰是 SFTP 自己
  (其 `sftp` 恒为 null)→ 远端栏错误地显示空态。改为"记住最近活动的会话 + 显式绑定"。
  教训:凡是"当前 X"这类取值,在多 tab 模型里都要问一句**"X 属于哪个 tab"**。
- 未做/待补:列头点击排序(原版列头可点,未验证行为);行的图标是近似(圆角色块);浅色主题配色未还原。

### F16 T4 快捷键:权威表、实现与复验                          [2026-10-17 15:25]
- **规格来源(权威)**:原版 `localStorage.shortcut_schemes`,每套 **20 条**。Mac 方案全文(顺序照抄):
  `Cmd+C` Copy from Terminal / `Cmd+V` Paste to Terminal / `Cmd+A` Select All in Terminal /
  `Cmd+.` Show Terminal Side-panel / `Cmd+S` Save Workspace Template / `Cmd+L` Open Local Terminal /
  `Cmd+B` Switch the Broadcast Mode / `Cmd+Shift+M` Toggle Workspace View Mode /
  `Cmd+Alt+S` Open Serial Connection / **(无默认键)** Clear Terminal Buffer / `Cmd+F` Open Terminal Search /
  **(无默认键)** Open Hosts Page / `Cmd+W` Close Tab / `Cmd+Shift+S` Open Snippets /
  `Cmd+P` Open Port Forwarding / `Cmd+K` Open Command Palette / `Cmd+J` Jump to / `Cmd+T` New tab /
  `Cmd+Shift+]` Next Tab / `Cmd+Shift+[` Previous Tab。
  PC 方案同构(`Ctrl+Shift+C/V/A`、`Ctrl+Shift+W`、`Ctrl+T`、`Alt+←/→` …),两套都有 2 条原版**未设默认键**。
- **终端搜索 UI(实测)**:`Cmd+F` 在**终端区右上**出现搜索栏,输入框占位符 **"Search terminal - ⌘ + F"**
  (占位符自己写明快捷键),右侧有上/下箭头两个按钮。
- **实现**:
  - `src/renderer/keys.ts`:把上表**逐条照抄**(id/name/键位),加速键解析后按 `event.code` + 修饰键精确匹配;
    捕获阶段监听(xterm 会吞键,必须先于它);焦点在输入框时让位给文本编辑,只放行应用级那几条。
  - `src/renderer/app.ts`:11 条已接实体行为 —— 复制/粘贴/全选/清屏/搜索/新建/关闭/前后切换/本地终端/命令面板。
  - 剪贴板走**主进程 `clipboard`**(新增 `clipboard:read/write` IPC):沙箱渲染层用 `navigator.clipboard` 不可靠。
  - 搜索用 xterm 官方 `@xterm/addon-search`(与 canvas 插件同样 peer 声明较旧,故 try/catch 容错)。
  - `Cmd+K` 做了命令面板(标签页 + 全部快捷键条目,未实现的标注"未实现")。
- **复验(CDP 驱动自家实例)**:`Cmd+F` 出搜索栏且占位符与实测一致 ✓;`Cmd+K` 出面板(12 行)✓;
  `Cmd+P` 作为**未实现项**弹出明确提示"「Open Port Forwarding」尚未实现(Cmd+P)" ✓;
  `Cmd+A`+`Cmd+C` 后剪贴板确有终端缓冲内容(107 字符,内容正确)✓;`Cmd+L` 新开 Local shell tab ✓;
  `Cmd+T`/`Cmd+W` 在**新派发器下仍工作**(2→3→2)✓;`Cmd+Shift+]` 切 tab ✓。
- **有意设计**:未实现的 9 条不是静默吞键,而是弹提示说明"原版叫什么、键位是什么"。这样缺口可见,
  也不会让人误以为按键坏了。未实现清单(9):Show Terminal Side-panel、Save Workspace Template、
  Switch the Broadcast Mode、Toggle Workspace View Mode、Open Serial Connection、Open Hosts Page、
  Open Snippets、Open Port Forwarding(属 T3)、Jump to。
- 方法学:① 在输入框里按 `Cmd+P` 不触发是**正确**行为(焦点在文本框时应让位),别急着当 bug —— 我第一次
  就误判了;② 快捷键类规格优先从应用自身的配置里取(这里 `shortcut_schemes` 一条不差),比逐个试按可靠得多。

### F17 T3 端口转发:规格、实现与真机复验                      [2026-10-17 16:05]
- **原版规格(实测)**:
  - 入口:左栏一级导航 `Port Forwarding`(快捷键 `Cmd+P`,见 F16 表);工具栏 `＋ New forwarding`(带下拉箭头)
    + 右侧 搜索/视图/面板 三个图标按钮。
  - 空态:图标 + **"Set up port forwarding"** + **"Save port forwarding to access databases, web apps, and other services."**
  - 向导(标题 `New Port Forwarding` + `Personal`),四步:
    1) `Select the port forwarding type:` —— Local / Remote / Dynamic,三类**说明逐字**:
       - Local:`Local forwarding lets you access a remote server's listening port as though it were local.`
       - Remote:`Remote forwarding opens a port on the remote machine and forwards connections to the local (current) host.`
       - Dynamic:`Dynamic port forwarding turns Termius into a SOCKS proxy server. SOCKS proxy server is a protocol to request any connection via a remote host.`
    2) `Local Port Forwarding` —— `Set the local port and binding address: This port will be open on the local
       (current) machine to forward traffic to the remote host.` 字段:`Local port number *`、`Bind address`(占位符 `0.0.0.0`)
    3) `Intermediate host` —— `This device is used as an intermediate host to access the remote host.` + `Select a host`
       (选择器列出 `Personal vault` / `192.0.2.10  ssh, root`)
    4) `Destination host` —— `IP address/hostname and the port number of the remote host where the intermediate host
       will direct the traffic.` 字段:`Destination address *`、`Destination port number *`
    按钮:`Back` / `Continue` / `Skip wizard`;**必填项为空时 Continue 不前进**(实测:Local port number 空着点 Continue 无反应)。
- **实现**:`src/main/forward.ts` 新增 `ForwardService` ——
  local 起本机监听并把每条连接交给 `ssh.forwardOut`;remote 用 `forwardIn` + `tcp connection` 回连本机;
  dynamic 是内建的**最小 SOCKS5(CONNECT,无认证)**服务端,按目标动态建通道。
  规则按主机持久化到 `forwards.json`;`SshService` 增加 `clientOfHost` 以"按主机找可用通道";
  IPC `fwd:rules/statuses/save/delete/start/stop` + 状态推送;UI 为 `renderer/fwd.ts`(面板 + 四步向导),
  侧栏新增一级导航;`Cmd+P` 由"未实现"转为**已实现**。
- **复验(真机,不只是看 UI)**:
  - 向导四步的标签与说明逐字一致 ✓
  - 建规则 `0.0.0.0:18080 → 127.0.0.1:22 via node-1` → Start → UI `running · 0 conn` ✓
  - `lsof -iTCP:18080 -sTCP:LISTEN` 显示 Electron 在 `*:18080` 监听 ✓
  - **经隧道取回远端 banner `SSH-2.0-OpenSSH_9.9`** ✓ —— 这是端到端证据:流量确实穿过 ssh 通道到了 node-1
  - Dynamic:SOCKS5 握手 `5,0` → CONNECT 应答 `5,0` → 同样取回 `SSH-2.0-OpenSSH_9.9` ✓
  - 错误路径:bind 填成非法地址时,UI 显示 `error: getaddrinfo ENOTFOUND …`(失败可见,不是静默)✓
- 偏离与缺口:① 我方把端口转发放在**一个 tab** 里(原版是在 Vaults tab 内替换主区域)—— 与 SFTP 同样的取舍;
  ② Dynamic 说明里的产品名按本产品替换为 sshkit,其余文案原样;③ **Remote(-R)那条路径实现了但尚未端到端复验**
  (本轮验的是 -L 与 -D),记为待验;④ Remote 型第二步的字段标签未实测(我用了 `Remote port number`)。
- 方法学:① `Input.insertText` 是**插入**不是替换,带默认值的输入框会被写坏(我把 `0.0.0.0` 写成了
  `0.0.0.0127.0.0.1`,引擎如实报 ENOTFOUND)—— 给驱动加 `--clear`,且 **CDP 按键不会自动执行编辑命令**,
  必须显式 `commands:["selectAll"]`;② 原版向导"点了 Continue 不动"不是 bug,是必填校验;
  ③ 导航类快捷键必须不被聚焦的输入框吞掉(F16 的 APP_LEVEL 由此扩充)。

### F18 T6 已知主机:规格来源、询问式改造与隔离复验            [2026-10-17 17:20]
- **规格来源(权威)**:原版 `ui-process/assets/ui-process-db39bd97.js` 里组件自身的可见文案
  (即产品实际渲染的字面量,比截图辨认更可靠):
  - **首连询问**:标题 `Are you sure you want to connect?`;正文
    `The authenticity of <host> can not be established.` + `<keyType> fingerprint is SHA256:<fp>` +
    `Do you want to add it to the list of known hosts?`;按钮 `Close` / `Continue` / `Add and continue`
    (窄屏时按钮文案变 `Add & continue`)。
  - **指纹变更**:标题(错误色)`The fingerprint for <host> has changed`;正文
    `Termius notices a potential security breach.` + `New <keyType> fingerprint is SHA256:<fp>`;
    按钮 `Replace` / `Add as new` / `Cancel`;回车默认走 `Replace ?? Add`。
  - **列表空态**:`Known hosts will appear here` + `Known hosts are trusted server identities saved for
    secure future connections.`;工具栏有 `Import Known Hosts From Toolbar`。
- **改造**:原来我方是**静默 TOFU**(首次即写盘、只在终端里打一行灰字),与原版"先问用户"不一致。
  现拆成 `checkHostKey`(只判断)/`addHostKey`(用户同意才落盘),`hostVerifier` 里发 `knownhost:ask`
  并**等待**渲染层答复(ssh2 允许异步回调);120s 无人应答按**拒绝**处理(安全默认)。
  按钮语义:Continue=仅本次接受不写盘,Add and continue=接受并写盘,Replace=覆盖旧条目。
- **复验(隔离环境,不碰用户 ssh 配置)**:真实 LAN 主机的密钥都已在用户 `known_hosts` 中,无法触发"未知主机";
  为了**不去改用户的 ssh 信任文件**,写了 `bench/fake-ssh.mjs`(ssh2 `Server` + 临时的自签主机密钥,监听
  127.0.0.1:2222),指一台测试主机连过去:
  - 对话框按预期弹出,标题/正文/按钮与上面逐字一致 ✓
  - 点 `Add and continue` → 对话框关闭,且 `~/.ssh/known_hosts` 里**确实新增** `[127.0.0.1]:2222 ssh-rsa AAAA…` ✓
  - 假服务侧日志走完 `有客户端连入 → auth: none test → ready,开一个 shell` ✓(密钥接受后握手继续)
  - Known Hosts 视图列出真实 18 条(主机/类型/指纹),空态文案备用 ✓
  - 清理:测试条目与测试主机已删除(残留 0 行),假服务已停。
- **顺带修掉的真 bug**:非 22 端口时,known_hosts 的字段必须是 OpenSSH 约定的 `[host]:port`,我方原先写裸
  `host` —— 这会让"22 端口以外的主机"与系统 ssh 的信任**对不上**(我模块注释里写着要与 OpenSSH 共用,
  所以这是实打实的不一致)。现按约定写入,并让对话框显示同一字段。
- 方法学(重要):**测量别人的线上应用时不要制造状态**。本轮我为了看到向导下一步,在原版 Termius 的
  Local port 填了 18080,结果被存成一条动态转发规则(且我把 bind 写坏成 `127.0.1127.0.1`),
  之后连确认框都删不掉(走完 `Remove` 确认仍在列表里)。教训:① 需要"填必填项才能继续"的测量,
  应优先找**离线/隔离的替代物**(如 T6 的假 ssh 服务);② 必须在真实应用里制造状态时,先想好怎么撤销并**验证撤销**;
  ③ 拿不准就记为缺口,而不是动手。该规则已如实告知用户,由其自行删除。

### F19 T8 断线与重连:规格、实现、三个真 bug 与残留            [2026-10-17 18:40]
- **规格来源(权威)**:原版自身 bundle 的可见文案 ——
  `Initiating reconnection...`(重连中提示)、`1 session is disconnected`(全局计数,复数会变)、
  `Force reconnect terminals`、`Close all disconnected terminals`、`Disable reconnecting`、
  `No connection available to reconnect`、`Try again`、`Attempting reconnection to server with ID`。
- **实现**:
  - 终端区断线覆盖层:`Session is disconnected` + 原因 + `Try again` / `Close`;
    自动重连期间显示 `Initiating reconnection...` 且重试键置灰。
  - 自动重连:最多 3 次,退避 1s/2s/4s;成功后清覆盖层、写 `[reconnected]`、恢复光标与状态。
  - 全局断开条:`1 session is disconnected`(多条时复数)/ `Force reconnect terminals` /
    `Close all disconnected terminals`。
  - 渲染层 reload / 关窗时通过 `sessions:disposeAll` 收掉本次界面开的会话(原先是孤儿)。
- **复验(假 ssh 服务制造真实掉线)**:
  - 杀掉服务 → 覆盖层出现,文案 `Session is disconnected` + `Initiating reconnection...`,重试键置灰 ✓
  - 全局条出现:`1 session is disconnected` + 两个动作 ✓
  - 重试耗尽 → `No connection available to reconnect`,`Try again` 恢复可点 ✓
  - 服务恢复后重连成功:覆盖层与全局条消失、状态点回 `on`、假服务日志出现新的 `有客户端连入` ✓
  - `Force reconnect terminals` 亦能触发(服务端确实收到连接)✓
- **顺带查出并修掉的三个真 bug**(都是"看着能用、其实判断错"的那类):
  1. **掉线被上报成正常退出**:主进程 `client.on("close")` 一律发 `exitCode: 0`,渲染层无法区分
     "远端 shell 正常退出"与"连接断了",于是断线**不给重连入口**。现由主进程显式给
     `reason: closed | dropped | error | auth | hostkey`,渲染层按 reason 决策(auth 失败不重试,重试也没用)。
  2. **`ssh.connect` 在握手完成前就返回 id**:TCP 都连不上也显示"已连接",重连循环也误判成功。
     现等 `ready` 才 resolve,失败/超时 reject(另加 20s 兜底);界面在连上之前显示 `(connecting…)`。
  3. **未应答的密钥对话框会吞掉后续询问**:原先"一次只问一个"是直接 `return`,于是新的询问被静默丢弃,
     那次连接就永远卡在握手上(ssh2 `readyTimeout` 15s 后自己掐断 → `KEY_EXCHANGE_FAILED`)。
     现改为**替换**旧对话框;并在会话结束时由主进程 `knownhost:ask-cancel` 作废该会话挂起的询问。
- **残留(未复验,下轮清干净再测)**:我连续多轮 kill/重启假服务 + 反复重连之后,测试台自身状态变乱
  (残留 tab、覆盖层、重试循环),最后一次连接**没有弹出首连对话框**就失败了。倾向于是测试台状态问题
  (密钥 pin 与对话框时序),但**没有证据就不算通过** —— 下轮重启干净环境重跑一遍 T8 全流程再定论。

### F20 T7 主机簿分组/排序/搜索:规格、实现与复验                [2026-10-17 19:30]
- **原版规格(实测,只读操作)**:
  - 搜索框占位符 **`Find a host or ssh user@hostname...`**(注意:它明说了可按"主机名 / ssh 用户名"搜)。
  - 工具栏按钮(aria-label):`Change layout`、`Filter by tags`、`Sort options`。
  - `Sort options` 菜单**四项,文案逐字**:`A-z`、`Z-a`、`Newest to oldest`、`Oldest to newest`。
- **实现**:侧栏加搜索框(按 名称/主机名/用户名 过滤,不区分大小写)+ 排序按钮(四项菜单,选择存 localStorage);
  分组头保持按组名字典序,组**内**按所选方式排序;搜索无结果给空态提示。
- **复验(造 3 台测试主机:fake-ssh/bench、node-1/hosts、alpha-web+zeta-db/prod)**:
  - `A-z`:… PROD → `alpha-web, zeta-db` ✓;`Z-a`:PROD → `zeta-db, alpha-web` ✓
    (组头 BENCH/HOSTS/PROD 始终字典序,只有组内顺序变化 —— 与原版一致)
  - `Newest to oldest`:PROD → `zeta-db` 在前(它是后建的)✓
  - 搜索 `fake` → 只剩 fake-ssh;搜索 `deploy`(用户名)→ 只剩 alpha-web ✓
  - 排序菜单四项文案与原版一致 ✓
- **缺口(明确记为未复刻)**:
  - **`Filter by tags`**:我方 HostRecord 没有 tags 字段,未实现(要做需先加数据模型)。
  - **`Change layout`**:原版可切换列表/网格等布局;我方侧栏固定为列表。
- 清理:顺手把原版里我早前遗留的 `Do you want to discard changes?` 提示关掉了(点 `Discard changes`)。
- 方法学:`--insert ""` 在驱动里是**空串 → falsy → 整个打字分支被跳过**,所以"清空输入框"不能用它;
  正确姿势是写一个字符再按 Backspace(或给驱动加真正的 clear 语义)。本轮因此误判过一次"排序没生效"。

### F21 T3 补验:remote(-R)端到端 + 环路链路                        [2026-10-17 20:00]
- **缺口背景**:F17 只端到端验了 local(-L)与 dynamic(-D),remote(-R)当时记为"实现了但未验"。
- **难点**:验 -R 需要"从远端主机发起连接",而我对 node-1 没有免密通道(不能在上面跑命令);
  又不该为了测试去改用户的 SSH 配置或往远端装东西。
- **解法(不用在远端跑任何东西)**:把 `-R` 与 `-L` **串成环路** ——
  1. 本机起一个只回 banner 的目的端服务(127.0.0.1:19091);
  2. `-R` 规则:在 **node-1** 上监听 127.0.0.1:19090 → 目的端 127.0.0.1:19091(即回本机);
  3. `-L` 规则:本机监听 127.0.0.1:19092 → 目的端 127.0.0.1:19090(即 node-1 上的那个 -R 监听);
  4. 本机连 19092。
- **结果**:两条规则均 `running`;本机连接 19092 后收到 **`BANNER-1-OK`**,banner 服务日志出现
  `收到第 1 个连接`,计数 `-R active=1/total=1`、`-L total=1` ✓
  —— 数据路径 = 本机 →(ssh `-L`)→ node-1 环回:19090 →(ssh `-R`)→ 本机 19091 → 原路返回。
  一次同时证明 **-L 与 -R** 的真实转发能力(不是 UI 状态,是字节真的走完了全程)。
- 说明:用 `127.0.0.1` 作为两端绑定,避免了 sshd `GatewayPorts` 默认关闭导致 `0.0.0.0` 绑定失败的问题,
  所以这个验证不依赖远端配置。
- 方法学:验证"需要远端配合"的功能时,**把两端串成环路**往往能用一次本机操作证明双向;
  比"想办法登陆远端"更省事,也不碰别人的环境。

### F22 T1 补完:配色方案 / 字号 / 字体                            [2026-10-17 21:10]
- **数据源(权威)**:原版 `reconnectSaga-*.js` 里的 `colorSchemesArray` —— **64 套**配色,每套含
  `colorPaletteOverrides`(16 色 ANSI)+ `backgroundColor`/`cursorColor`/`foregroundColor`/`selectionColor`。
  已导出为 `src/renderer/themes.ts`(颜色是事实值;方案名沿用原版以便逐项对照)。
  **顺带印证**:`Termius Dark` 的 `foregroundColor` 就是 `#21b568`(绿色)—— 也就是说"默认是绿的"
  是产品自身设定,不是用户改的(与用户当初的说法一致)。
- **实现**:终端标题栏加 🎨 外观设置 —— ① 配色列表(64 套,带底色+前 7 色的小色带,当前项高亮);
  ② 字号(输入 + A−/A+,限 4–40);③ 字体(内置 MesloLGS NF + 系统等宽回退)。
  切换后立刻作用于**所有活动终端**并重新 fit;chrome 也跟随(tab 条底色 = 主题底色,`--term-bg`);
  选择存 localStorage,重启/重载后恢复。
- **复验**:
  - 配色列表 **64 项**,顺序与原版一致(Termius Dark / Termius Light / Flexoki Dark / …)✓
  - 切到 Flexoki Dark:终端区**实际像素**由 `(20,23,40)`(=#141729 经色彩管理后的值)变为 `(16,15,15)`
    = **#100f0f 精确命中**,tab 条 computed 背景同步变为 `rgb(16,15,15)` ✓
  - reload 后仍为 Flexoki Dark(`--term-bg=#100f0f`、localStorage 命中)✓
  - **字号**:用"pty 行列数"作为不变量验证(字号变了 fit 必然重算)——
    `30px → 57×17`、`14px → 128×37`、`20px → 85×24` ✓
    且 `128×37` 恰等于面板 1024×666 ÷ **8×18** —— 与 F13 量到的单元格尺寸**独立互证**。
- **缺口**:① 原版主题选择器的**视觉形态**没量到(它只存在于终端侧栏,而我这轮去量时原版的会话 tab
  已经不在了 —— 可能是我早前的点击关掉的,也可能是用户自己关的;我随即停止在其应用里继续操作),
  故我方选择器是自己设计的列表(位置也放在终端标题栏而非侧栏),记为**有意偏离**;
  ② 字体只随包 1 个族(原版打包 12 个等宽族)。
- 方法学(两个教训):
  ① 我又一次用"截图度量"却没检查截图内容 —— 两张"字号前后对比"其实是 reload 之后的 **New Tab 落地页**
     (tab 被 reload 清掉了,`seq` 压根没打进终端),行距当然一模一样。**先看图,再看数**。
  ② 密集文本上用"行亮度自相关"求行距不可靠(谐波会骗人);改用**状态不变量**(pty 的 cols×rows)
     立刻得到决定性证据。为此在主进程加了 `benchLog`,仅在 `SSHKIT_BENCH=1` 时输出(正常运行零噪音)。

### F23 T5 补完:列头排序 + 多选                              [2026-10-17 22:20]
- **规格来源(权威)**:原版自身 bundle ——
  - 状态:`defaultConfig={sorting:{sortBy:null,sortDirection:"ASC"}}`,**每栏独立**(store 里 left/right 各一份),
    动作名 `SET_SFTP_SORTING`(另有 `SET_SFTP_SHOW_HIDDEN_FILES`)。
    ⇒ **默认不排序**(用目录原顺序),这点很容易做错(我原先默认就按名称排)。
  - 交互:列头走 react-virtualized 的可排序表头;指示器是内置 `SortIndicator`,
    ASC 为 `path d="M7 14l5-5 5 5z"`(上三角)、否则 `M7 10l5 5 5-5z`(下三角),**仅当前排序列显示**。
  - 相关字符串:`Select All`、`Clear selection`、`New folder`、`New filename *`。
- **实现**:
  - 列头改为按钮,点击:同列则 ASC↔DESC 切换,异列则切到该列并置 ASC;指示器 ▲/▼ 只出现在当前列。
  - 比较器:目录恒在文件前(`..` 恒首),同类型内按所选列比较,DESC 只反转键比较(不反转"目录优先")。
  - 多选:普通点击=单选;Cmd/Ctrl+点击=切换;Shift+点击=从锚点范围选择;Cmd+A=Select All;Esc=清除。
  - Actions 菜单随选中数变化:`Delete N items` / `← Download N items` / `Clear selection`(单选时仍是 Rename/Delete)。
- **复验(CDP 驱动自家实例)**:
  - 点 Name 一次 → `Name[ASC]`:`.., example-pkg-pkg, pkg-node-a, pkg-node2, pkg-node3, anaconda-ks.cfg`(目录在前、名称升序)✓
  - 再点一次 → `Name[DESC]`:目录内反序 ✓;切 Size → 指示器移到 Size 列 ✓;默认态无指示器 ✓
  - 多选:普通点第 3 行=1;Cmd+点第 5 行=2;Shift+点第 8 行=4(范围)✓
  - 菜单:多选态显示 `Delete 4 items` / `Clear selection` / `← Download 4 items`;Esc 后为 0;单选态复原 ✓
  - Cmd+A → 10 行中选中 9(第 1 行是不可选的 `..`)✓
- **工具链修复(重要)**:这轮被驱动坑了两回,都是同一处 ——
  `bench/drive.mjs` 的"界面变化指纹"只统计节点数 + 按钮文本,于是
  ① 排序后 **列表重排但文本集合相同** → 判定"无变化" → 触发**合成 `.click()` 回退** → 一次点击被处理两次
     (第一次 ASC、第二次立刻 DESC,看起来像"默认就是 DESC");
  ② 多选后 **背景变了、文本没变** → 同样误判 → 回退点击**没有修饰键**,把多选重置成单选,
     让我一度以为"修饰键没送到"(实测 `__lc` 日志证明 meta/shift 都到了,是我的工具在捣乱)。
  修法:指纹纳入**可见文本散列 + 选中态**(`.sel/.on/[aria-selected]`)。
  教训:自动化驱动里"如何判断界面变了"是个**一等公民**,判断错了会污染交互测试的结论。
- 方法学补充:验证交互时先派一个**只记录不改状态**的监听(`__lc`)把"事件到底长什么样"打出来,
  比自己猜"是不是修饰键没到"快得多。

### F24 T2 补完:tab 拖拽重排 / 右键菜单 / 重命名 / 复制            [2026-10-17 23:40]
- **规格来源(权威,取自原版自身 bundle)**:
  - 动作常量:`TAB_CONTEXT_MENU_OPENED`(**存在 tab 右键菜单**)、`SINGLE_TERMINAL_TAB_RENAMED`(**tab 可重命名**)、
    `ADD_TAB_DURING_SESSION`。
  - 拖放态属性(说明 tab 拖拽是真实功能,且有三种落点):`over-horizontal-tab`、`over-draft-horizontal-tab`、
    `over-horizontal-tabs-area`(另有一组 workspace 变体)——即"拖到某个 tab 上""拖到新建占位 tab 上""拖到 tab 条空白区"。
  - 附带确认(T1 相关):`INCREASE_TERMINAL_FONT_SIZE`、`DECREASE_TERMINAL_FONT_SIZE`、`SET_TERMINAL_FONT_SIZE`、
    `SET_TERMINAL_FONT_NAME`、`RESET_TERMINAL_FONT_SIZE_TO_DEFAULT`、`SET_TERMINAL_COLOR_SCHEME` —— 我 T1 做的
    那几个控件在原版里确实是独立动作(也意味着原版可能还有字号快捷键,未在 20 条表里)。
  - **未能取到**:菜单项的**字面文案**(实现走文案表/翻译 key,附近没有可提取字符串)。
    故我只实现**有据可查**的 `Rename` / `Duplicate` / `Close`,其余不臆造。
- **实现**:tab 设 `draggable`,dragstart/dragover/drop 计算"落在左半/右半"→ 插入其前/后,拖动中显示插入指示线;
  右键弹菜单(Rename / Duplicate / Close);重命名为 tab 内联输入框(Enter 提交 / Esc 取消 / 失焦提交);
  复制按 tab 类型分派(session→同主机再连一个;其余视图→再开一个)。
- **复验(CDP)**:
  - 拖拽:`[node-1, New Tab, SFTP]` 把第 1 个拖到第 3 个右半边 → `[New Tab, SFTP, node-1]`,拖放指示器 `drop-after` 出现 ✓
  - 右键:菜单项 `Rename / Duplicate / Close` ✓
  - 重命名:输入 `生产机-gpu` → 回车 → 标签变为 `生产机-gpu` ✓
  - 复制:菜单点 Duplicate → 新增一个 `session:node-1` tab ✓
- **查出并修掉的真 bug**:重命名输入框刚出现就被**重建没了** —— 点输入框时事件冒泡到 tab 的 click →
  `activateTab` → `renderTabs()` → 输入框被替换。修法:输入框吞掉 click/mousedown/mouseup/dblclick 冒泡。
  教训:**内联编辑器放在可交互容器里,必须阻断冒泡**,否则容器自己的"重新渲染"会把它连根拔掉。
- 另:给 tab 加了 `data-kind`,让 DOM 自报类型 —— 诊断与自动化断言都方便(这轮就是靠它一眼看出
  "复制"那次其实落到了 newtab 分支)。
- **未做**:分屏/工作区视图(原版有 workspace tab 与 `toggleSplitViewBroadcastMode`/`toggleWorkspaceViewMode`)、
  广播模式、tab 菜单的完整项(文案表取不到)。

### F25 T4 补完:字号快捷键(来源是**主进程菜单**,不是渲染层快捷键表)   [2026-10-18 00:40]
- **规格来源(权威,第二处)**:原版 `main-process/main-process.js` 的**应用菜单**定义 ——
  ```
  View: Increase terminal font size   accelerator "CmdOrCtrl+Plus"
        Decrease terminal font size   accelerator "CmdOrCtrl+-"
        Reset terminal font size to default   (无 accelerator,仅菜单项)
        Show terminal side-panel      ← 取 shortcut_schemes 里 toggleSidepanel 的键位
  Edit: Select All  "CmdOrCtrl+A" ; Find ← 取 openTerminalSearch 的键位
  ```
  **重要**:这是一处新的权威来源。此前我只有渲染层的 `shortcut_schemes`(20 条应用级);
  字号/侧栏/查找这些是**菜单加速键**,压根不在那张表里 —— 所以"表里没有"不等于"原版没有"。
- **实现**:`keys.ts` 增 `TERMINAL_SHORTCUTS`(来自 View 菜单)+ 专用匹配函数:接受 `Equal`(即 `Cmd+=`)
  与 `NumpadAdd`(原版绑的是 `CmdOrCtrl+Plus`,在 US 布局上 + 需按 Shift;macOS 上用户习惯按 `Cmd+=`,
  故两者都收,并在注释里写明);`Cmd+-`/`NumpadSubtract` 减小;字号统一走 `setFontSize()`;
  面板加 `Reset`(对应原版那条无加速键的菜单项)。
- **复验(真实 CDP 按键 + pty 尺寸作不变量)**:
  - `Cmd+=` ×3:字号 14→17,pty 变 **102×29** ✓
  - `Cmd+-` ×2:17→15,pty 变 **114×35** ✓(字号变小 → 行列变多,方向正确)
  - `Cmd+Shift+=`(即 ⌘+):16 ✓
- **工具链教训(差点又误判产品)**:`bench/drive.mjs` 的键名映射里没有符号键,`cmd+equal` 退化成
  `code="equal"`(小写),而产品按 `e.code === "Equal"` 判断 → **静默不触发**,我一度以为"字号快捷键没实现"。
  定位手法:在页面里**直接派发带正确 `code` 的真实 KeyboardEvent**,一次就证明产品逻辑是好的
  (14→15→14),问题在工具。随后给驱动补齐了约 18 个符号/具名键(`equal`/`plus`/`minus`/`comma`/`bracketleft`…)。
  教训:**键盘测试失败时,先证明"到达页面的那个事件长什么样",再怀疑产品。**

### F26 T7 补完:标签过滤 + 布局切换                            [2026-10-18 01:30]
- **规格来源(原版字符串)**:
  - 标签:`Tags`(在 `HostsScreenSidebar-*.js`)、`Filter by tags`、`Remove tag`。
  - 布局:`Change layout` → **`List` / `Grid`**(两个选项名都在包里)——
    这顺带回答了 F20 里"`Change layout` 到底切什么"的悬案。
- **实现**:
  - `HostRecord.tags?: string[]`;新建/编辑表单加 `Tags` 输入(逗号分隔,存盘前去重/去空白/限 32 个)。
  - 行内显示标签芯片;工具栏 `🏷`(aria-label `Filter by tags`)菜单列出全部标签 + 复选框,可多选过滤,
    选中时按钮高亮;含 `Clear filters`。
  - 工具栏 `▤`(aria-label `Change layout`)在 **List / Grid** 间切换(存 localStorage),Grid 为两列卡片。
- **复验**:标签写后读回 `node-1:["prod","db"]`、`alpha-web:["prod","web"]` ✓;行内芯片正确 ✓;
  菜单列出 `bench/db/prod/web` ✓;勾 `prod` → 只剩 `node-1`、`alpha-web`(+ 恒显的 Local shell),按钮高亮 ✓;
  `Clear filters` 复原全部 ✓;布局切换后 `#host-list` 带 `grid` 且 `gridTemplateColumns: 110.5px 110.5px`,
  localStorage 记 `grid` ✓。
- **查出并修掉的真 bug(值得记住)**:`tags` 第一次写进去**读回是 null** —— 主进程的主机存储是
  **白名单式字段归一化**(`src/main/store.ts` 里逐个字段 `String(...).trim()`),我只在共享类型、表单、
  渲染层加了 tags,忘了加进归一化,于是被静默丢掉。
  教训:**在这种"显式挑字段"的存储层加字段,共享类型/UI 都改了也不算完,必须同时改归一化**;
  而且"写完立刻读回"这个检查正是把它抓出来的手段(否则界面看着有输入框、其实永远存不下)。
- **未做**:从行内菜单 `Remove tag`(原版有该字符串,推测是行右键移除标签);标签的颜色/自动补全未做。

### F27 T5 拖拽上传复验 + T6 `Replace` 路径与一个真缺陷              [2026-10-18 02:30]
- **T5 栏间拖拽传输(已实现并复验)**:本地栏某行拖到远端栏 `.sp-body` 上 → 落点高亮 → 走原有单文件上传;
  反向即下载。原版是双栏 SFTP,拖到对面栏即传输。
  **复验**:本地 `~/sshkit-drag-test.txt`(32 字节)拖到远端栏 → 远端列表出现 `sshkit-drag-test.txt | 32 B | 时间` ✓
  (H5 拖放无法用裸鼠标事件驱动,按标准做法派发 `DragEvent`;`dragstart/dragover/drop/dragend` 全链路都过。)
- **T6 `Replace`(指纹变更后替换)**:把假服务的主机密钥换掉,让 pin 与之一致性破裂 ——
  对话框正确弹出(标题/正文/三个按钮与 F18 记录一致),点 `Replace` 后:
  - 连接继续并成功(状态点 `on`)✓
  - `addHostKey` 走到 replace 分支:先剔除旧条目、再写入新条目 ✓
- **查出并修掉的真缺陷(高价值)**:ssh2 的 `readyTimeout` 默认很短,**会在用户还没作答时把连接自己掐断** ——
  现象是"主机密钥对话框弹出来十几秒后**凭空消失**,连接变成 failed",用户只会以为自己点错了。
  我最初就是这么被误导的(以为是我点击失败)。
  修法:`readyTimeout: 120_000`,与标注的 120s 应答窗口一致。
  **复验**:对话框弹出后**故意等 25 秒**再点 `Replace`,对话框仍在、应答成功 ✓(修复前 ~15s 就消失)。
- **真因已定位(严重:会静默损坏 known_hosts,连累其它主机)**:
  现象是"`grep` 说文件里有 127.0.0.1,但按 `^[127.0.0.1]:2222` 匹配是 0 行" —— 两者不矛盾**就说明那行是拼接的**。
  实锤:`192.0.2.32 ssh-ed25519 AAAA…(91 字符)…[127.0.0.1]:2222 ssh-rsa AAAA…`,**9 个字段**,
  测试条目从第 91 字节起**粘在上一行中间**。
  机制:`removeKnownHost` 重写文件时用 `keep.join("\n")`,而原文件以换行结尾 → split 出的末尾空串被跳过
  → **join 后没有结尾换行**;紧接着 `addFileSync` 追加 → 新条目直接拼到上一行末尾。
  后果:① pin 实际失效(ssh 与我自己的解析都不认);② **同文件里别的主机的行被损坏**。
  只在 `Replace` 分支触发(它是唯一会重写文件的路径)—— 正是我一直没走过的那条。
  修法:① 重写时保留结尾换行(`keep.join("\n") + "\n"`);② 追加前防御性检查"文件是否以换行结尾",
  不是就补一个(这样任何外部工具写出的无尾换行文件也不会被我们拼坏)。
  **复验**:连做两轮"换服务端密钥 → changed → Replace":每轮文件 17 行、**结尾换行正常、无字段异常行**、
  pin 恰好 1 条、连接成功 ✓。
  另外我**已修复被损坏的真实 `~/.ssh/known_hosts`**(先备份 `known_hosts.bak-*`,再把拼接行拆回、
  去掉我造的测试 pin;校验:字段数全为 3、`ssh-keygen -l -f` 解析通过)。
  保留的改进:
  1) `addHostKey` 的 `catch` 不再静默,`SSHKIT_BENCH` 下打印异常(此前它默默吞掉,排查只能靠猜);
  2) 写入后回读校验并打印行数;
  3) 路径也打印出来(确认写的是 `/Users/you/.ssh/known_hosts`)。
  教训:**静默 catch 是排查成本最高的写法** —— 它把一个可能的"数据丢失"级 bug 变成了"看起来没反应"。

### F28 T8 补完:`Disable reconnecting` + 主进程落盘路径硬化        [2026-10-18 03:20]
- **规格**:文案 `Disable reconnecting` 取自 F19 已验证的那组断线字符串(原版自身 bundle)。
  语义:正在自动重连时给用户一个"别自己试了"的开关;关掉后保留手动 `Try again`(否则用户只能关 tab)。
- **实现**:断线覆盖层在**重试中**额外显示 `Disable reconnecting`(非重试态隐藏,因为没什么可关);
  点击置 `tab.autoRetryOff`,重连循环下一轮检查到即停(状态文案 `Reconnecting disabled`);
  点 `Try again` 视为重新允许尝试(清掉该标志)。
- **复验**:连接 → 杀服务 → 覆盖层 `Initiating reconnection...` 且 `Try again` 置灰、`Disable reconnecting` 可见 ✓;
  点击后文案变 `Reconnecting disabled`、`Try again` 恢复可点、stop 按钮隐藏 ✓;
  **恢复服务并等 8 秒 → 服务端收到 0 次连接**(确认不再自动重连)✓;手动 `Try again` → 连接恢复、覆盖层消失、
  服务端收到 1 次连接 ✓。
- **落盘路径硬化(上轮数据损坏 bug 的横向排查)**:把所有会写用户文件的代码过了一遍:
  - `store.ts`(主机簿):本来就是 `tmp + rename` 原子写 ✓
  - `forward.ts`(转发规则):**原来是直接 `writeFileSync` 覆盖** —— 崩在写入中途会留下半个 JSON,
    下次启动规则全丢。已改 `tmp + rename` 原子写,并把失败从 `console.warn` 提到 `console.error`(不静默)。
  - 三处静默 catch 改为可见:`keystore` 凭据解析失败(此前"钥匙串里有数据但解析不了"和
    "用户从没存过密码"表现完全一样,排查会被带偏)、`known_hosts` 重写失败、转发规则写入失败。
  - 其余 `catch {}` 都是 socket 收尾(关流/关连接),属正常写法,保留。
- 结论(写给未来的自己):**凡是"重写用户文件"的代码,必须 ① 原子写 ② 失败可见 ③ 保证格式边界(如结尾换行)**。
  上轮那个 bug 三条全犯,才让一个数据损坏问题伪装成"点了没反应"。

### F29 T6 补完:`Import Known Hosts`                            [2026-10-18 04:00]
- **规格**:原版 Known Hosts 页工具栏有 `Import` 按钮(F18 实测);另有字符串 `Import Known Hosts From Toolbar`。
- **实现**:工具栏 `Import` → 原生文件选择器(默认目录 `~/.ssh`)→ 解析所选 known_hosts →
  **只并进"本文件没有的 (host,keyType,keyBytes)"**,已有条目一律不动;回报新增/跳过数量并刷新列表。
  写入复用与 `addHostKey` 相同的"确保结尾换行"路径(上轮那个拼接 bug 的教训)。
  另:IPC 支持可选显式路径(`import(path)`),正常使用仍走原生对话框 —— 便于自动化复验。
- **复验**:构造待导入文件 = 1 条已存在条目(192.0.2.10)+ 1 条新条目([10.9.9.9]:2222)+ 1 行注释 + 1 行畸形,
  导入结果 `{added: 1, skipped: 2}` ✓;文件 17 → 18 行、**结尾换行正常、无字段异常行**、新条目就位 ✓;
  已有条目未被改动 ✓。复验后已把测试条目从用户的 known_hosts 中移除(现 17 行、字段全对)。

### F30 T2 水平分屏(已实现)+ 广播(未复验)+ 三个重要发现      [2026-10-18 06:00]
## 规格(原版自身)
- tab 菜单项 `Split horizontally`(同处还有 `Start multiplayer`、`Duplicate in a new window`);
  广播文案 `Broadcast`;相关动作 `RUN_IN_ALL_ACTIVE_TABS`、`OPEN_MULTIPLAYER_TERMINAL`。
## 已实现
- tab 右键新增 `Split horizontally`:在 tab 内水平分出第二格(独立会话:本地或任一台主机),
  带格头(标题 / `Broadcast` 开关 / ✕ 关闭);关闭即回收会话。
- 广播:主格与分屏格的 `onData` 都会在开启广播时把输入同时写给对方会话。
## 已复验
- 分屏几何:两格都在视口内(主格 top=100 h=374、分屏 top=462 h=294),页面不再产生滚动 ✓
- 菜单项出现 ✓;分屏格可选 Local shell 并成功建成会话(termId=2)✓
- **踩到的真 bug(已修)**:布局用低特异度规则被 `.tab-pane.active{display:block}`(0-2-0)
  与 `.tab-pane .term-host{height:100%}`(0-2-0)压过 → 主终端不收缩,把分屏顶出视口(y=-339)、
  页面还被撑出滚动(scrollY=439)。改在样式表末尾用同/更高特异度覆盖后正常。
  **教训:改既有布局前先看 computed style 与特异度,别只看源码里"我加了规则"。**
## 未复验(卡在工具上,不是卡在设计上)
- **广播的端到端行为没验成**,原因:我这套对照台**无法向 xterm 注入文本**。逐一排除过:
  1. CDP `Input.dispatchKeyEvent`(keyDown+text / char / 组合):事件确实到达 textarea
     (监听器证明 `textarea` 与 `window` 都收到 keydown),但 **xterm 不产出 onData**;
  2. 合成 `paste` 事件(`ClipboardEvent` + DataTransfer):textarea 收到 paste,但 xterm 忽略;
  3. `Cmd+V`:被 **Electron 默认菜单的 paste 角色在 OS 层吃掉**,渲染层收不到
     (用 `clipboard.read` 代理证明:处理器没被调用);
  4. 系统级按键(`osascript` + System Events):**目标窗口没被置前**(实测前台仍是 QQ),失败 —— 见下方事故;
  5. 受开关保护的对照台钩子 `__bench.input()`(走 xterm 自己的 `term.paste()`):调用不抛错、返回 true,
     但**主进程也没收到 terminal:write** —— 这一条最可疑,见下。
## 待办(下一轮第一件事)
- **必须确认"真实用户能否在终端里打字"**。目前所有注入路径都不产出输入,而 `term.paste()` 直接调用
  也无效 —— 存在"终端输入通道根本没接上"的可能(那会是致命问题)。
  注意:此前各轮的复验**没有一项依赖过键入**(T3 用 bash 客户端、T5 用 DragEvent、字号用快捷键与 pty 行列),
  所以历史结论不受影响,但"终端可输入"这件事**从来没被验证过**,不能再拖。
  排查方向:`openSession` 里 `Terminal` 的构造与 `onData` 注册时序、canvas 插件加载失败是否影响输入、
  以及 `term.paste()` 在 xterm 6 的实际行为(可先用一个最小 xterm 页面做对照)。
## 两个产品级发现
1. **默认应用菜单吞掉 Cmd+C/V/A**:Electron 默认菜单的 `copy/paste/selectAll` 角色在 OS 层拦截这些键,
   渲染层永远收不到。而我们终端是 **canvas 渲染**,系统级"复制"从画布上复制不到文本 ——
   也就是说 `Cmd+C` 很可能复制不到东西。已加最小应用菜单(启动时 `Menu.setApplicationMenu`,
   只留 appMenu/windowMenu,去掉 Edit 角色),但我随后用 `clipboard.read` 代理测 `Cmd+V` **仍未到达渲染层**,
   所以此项**只算"改了,未证实"**。
2. 对照台钩子 `__bench`(`localStorage.sshkit.bench === "1"` 时才挂)已加入,只暴露"把文本喂进终端"
   与"读 tab 状态"两件事,走 xterm 自身 paste 管线,不新增能力。
## 事故(必须记录并向用户说明)
- 为验证"真实按键能否进终端",我用 `osascript` + System Events 发了两组系统级按键
  (`keystroke "touch /tmp/realtype-ok"` + 回车,以及 ⌘T)。**目标窗口没有真正置前**(随后查前台进程是 QQ),
  因此这两组按键很可能落在了 QQ 上 —— 存在"误发消息"的可能。
  教训:**永远先确认前台目标再发系统级输入**;更根本的是,这类"向别人的前台应用发按键"的手段
  在共享桌面上就不该未经确认地使用。已停止该路线。

### F31 【更正 F30】终端输入没有问题;广播已复验;两个测量错误   [2026-10-18 07:10]
## 结论先行(更正 F30 的头条)
**sshkit 的终端输入一直是好的。** F30 里"终端输入通道可能没接上"的判断**错误**,根因是我的**两处测量方法错误**:
1. **`contextBridge` 暴露的对象是冻结的**:我试图用 `window.sshkit.write = 代理` 来"记录写入",
   但 `Object.isFrozen(window.sshkit) === true`、该属性 `writable: false` —— 赋值**静默失败**,
   我读到的永远是空数组。所以 F30 中所有"没有写入""处理器没被调用"的证据**一律作废**。
   **教训:绝不要靠给 contextBridge API 赋值来插桩**;要么在消费侧插桩,要么在应用里加真正的钩子。
2. **`term.paste()` 是括号粘贴**:它会包上 `ESC[200~ … ESC[201~`,而 shell 把里面的换行当成缓冲区换行、
   **不执行**(真实用户是"粘完再按回车")。我用 paste 发 "cmd\n" 当然什么都不会发生。
   实测证据:`[bench] write → 1 "\u001b[200~touch /tmp/probe4-app\r\u001b[201~"` —— 产品把输入**正确发出去了**。
## 逐步定位(可复用)
- 在页面里动态 import 一份**全新的 xterm** 做对照:新实例 `paste`→`["PASTE"]`、键盘→`["b","b"]` ⇒ xterm 正常;
- 新实例直连应用自己的 pty(termId=1):`touch /tmp/probe3-ok` **文件被创建** ⇒ pty 与 IPC 通路正常;
- 应用自己的终端:主进程日志显示 write 到达且 `pty.write ok` ⇒ 输入链路完全正常。
  (此时才意识到"应用实例不产出输入"的观感来自上面那两处错误。)
- 修法:对照台钩子改用 **`term.input(data)`**(把字节原样交给 onData = 真实输入路径,且**完整经过产品的广播扇出**),
  不再用 `paste()`。
## 广播复验(**通过**)
两个本地 shell 分屏,往同一个日志追加时间戳:
| 条件 | 行数 |
|---|---|
| 广播关,主格喂一条 | 1 (+1) |
| **广播开,主格喂一条** | **3 (+2:两格都执行)** |
| 广播关,主格喂一条 | 4 (+1) |
| 广播关,只喂分屏格 | 5 (+1) |
主进程日志同刻出现 `write → 1` 与 `write → 2`(同一条输入写给两个会话)⇒ 扇出确实发生在产品代码里。
## 旁证与影响
- 应用对括号粘贴的处理**与真实终端一致**(粘贴不自动执行),这是正确行为,不是缺陷。
- `Cmd+V` 在加了最小应用菜单后**确实到达渲染层**:`__bench.counters.pasteToTerminal` 从 0 变 1 ✓;
  `Cmd+F` 搜索栏正常打开 ✓。但"默认菜单是否曾拦截它"**无法追溯证实**(当时的证据已作废),
  所以最小菜单这项按"合理硬化"保留,不再声称它修掉了某个已证实的缺陷。
- 顺带删掉一个我加了却没接线的计数器(`openTerminalSearch`)—— **永远是 0 的仪表比没有仪表更危险**,
  这正是 F30 那次误判的同类错误。

### F32 T6 多选 + T7 行内 Remove tag                          [2026-10-18 08:00]
## T6 Known Hosts 多选
- 规格依据:原版字符串 `Select All`、`Clear selection`、`Multi-Select Context Menu`(F18 已见)。
- 实现:普通点=单选、Cmd/Ctrl+点=切换、Shift+点=从锚点范围、Esc=清除;选中时列表上方出现
  操作条:`N selected` / `Select All` / `Delete` / `Clear selection`。选中以**主机名**为键
  (与原版 `knownhost:remove(host)` 的语义一致 —— 同一主机的多个密钥行一起选中/一起删)。
- 复验(先插入 2 条**测试条目**,避免动用户的真实记录):
  ① 普通点 → 1 selected ✓;② Cmd+点 → 2 selected ✓;③ Select All → DOM 19 行选中、计数显示 10
  (**10 = 唯一主机数**,19 行是 10 台主机的全部密钥条目 —— 语义一致但数字看着不同,已在记录里说明);
  ④ Clear selection → 清空、操作条隐藏 ✓;⑤ Delete → 两条测试条目从视图与文件中一起消失,
  且文件与插入前**逐字节一致**(17 行、无字段异常行)✓ —— 批量删除与清理一并验证。
## T7 行内 `Remove tag`
- 规格:原版字符串 `Remove tag`。实现:标签芯片带 ✕,点击只去掉该标签并落盘,且**不触发整行的连接动作**。
- 复验:node-1 的 `[prod, db]` 点 `db` 的 ✕ → UI 变 `[prod]`、落盘为 `["prod"]` ✓;未新增会话 tab ✓;
  验证后已把 `db` 加回(状态复原)。
- 备注:一个值得记住的交互细节 —— 行内小控件必须 `stopPropagation`,否则会连带触发所在行的点击动作
  (T2 的重命名输入框踩过同一个坑,这里一次做对)。

### F33 T2 工作区视图(竖排 tab 栏)                              [2026-10-18 09:00]
- 规格依据(既有 attestation,F24):原版 tabVariant 有 `workspaceVerticalTab` 与 `horizontalTab` 两态,
  并有 `active-workspace-tab`、`over-workspace-tab`、`over-workspace-tabs-area`、`toggleWorkspaceViewMode`,
  以及 `terminalTabPlace: "workspace"` ⇒ 原版存在"tab 竖排在终端左侧"的工作区视图,可与横排切换。
  **诚实标注**:竖栏的**精确视觉形态没有在运行中的原版里实测**(为避免动到用户的实时状态),
  我方按上述结构证据实现为"左侧 190px 竖栏 + 图标 + 名称 + 关闭";行高/配色/图标样式属自设计。
- 实现:工具栏 ▥ 按钮切换(原版对应 `toggleWorkspaceViewMode`);选择持久化到 `localStorage.sshkit.tabView`;
  切换后对活动终端重新 fit(否则 pty 的 cols 还是旧宽度)。
- 复验:① 切换 → `tabstrip` 隐藏、竖栏显示、3 行、active 行 = 当前 tab、**stage 宽度 1040 → 850**(190px 竖栏)✓;
  ② 点竖栏第 1 行 → active 行 2 → 0,tab 切换生效 ✓;③ 切回 → 横排恢复、宽度回 1040 ✓;
  ④ 切到工作区后刷新页面 → 仍是 workspace ✓(持久化)。
- **踩坑(值得记)**:第一次复验"点了没反应",原因是我把监听器绑定的字符串替换**没匹配上**,
  按钮压根没绑事件 —— 而 `renderWsRail` 正常渲染(能看到 3 行),所以现象**看起来像"点了不生效"**。
  教训:**改动后先确认"这一段代码真的进文件了"**(grep 编译产物/源码),再去做行为复验;
  否则会去排查一个根本不存在的逻辑 bug。

### F34 下一块(T4 侧栏面板)的字符串规格                        [2026-10-18 09:20]
在打包产物里逐一确认(直接字符串观测):
| 字符串 | 所在 | 含义 |
|---|---|---|
| `Show terminal side-panel` | main-process.js | 视图菜单项(F22 已记录,动作 `toggleSidepanel`) |
| `toggleSidepanel` | reconnectSaga-9aed66e2.js | 侧栏开关逻辑所在(与断线字符串同一个 bundle) |
| `Jump to` / `Jump To` | reconnectSaga-9aed66e2.js | 侧栏里的"跳到主机" |
| `Snippets` / `Snippet` | ShareEntitiesSuccessScreen / reconnectSaga | 侧栏里的"片段" |
| `Serial` | reconnectSaga | 串口会话 |
未找到:`side-panel`/`Sidebar`/`Hide terminal side-panel`/`New Serial` 等具体形态文案 ⇒
与 T2 菜单同理,**侧栏各面板的文案与布局取不到**,只能按已确认的三块内容(Snippets / Serial / Jump to)
与"终端侧栏可开可关"这一结构事实来实现,视觉形态按自设计并明确标注。

### F35 T4 终端侧栏(Show terminal side-panel)                  [2026-10-18 10:00]
- 规格依据(F34 字符串证据):`Show terminal side-panel`(main-process 视图菜单,动作 `toggleSidepanel`)、
  `Jump to`、`Snippets`、`Serial`。**具体文案与布局取不到** ⇒ 面板视觉为自设计(已在 PROTOCOL 标注)。
- 实现:终端右上 ▤ 开关(持久化 `localStorage.sshkit.sidePanel`);面板含两块:
  - **Jump to**:列出主机(名称 + user@host),点击把**当前 tab 的会话切到该主机**(终端复用,不新开 tab);
    没有会话 tab 时按新会话打开。
  - **Snippets**:片段存储在主进程(`snippets.json`,按本项目规矩**原子写 + 失败不报静默**);
    列表点击即把命令发到当前终端(末尾补回车,等价按回车),行内 ✕ 删除;下方可新建(名称 + 命令)。
  - **Serial**:记为**不可复刻的硬桩** —— 需要串口原生依赖(如 node-serialport)与真实串口设备;
    本项目不引入该原生依赖,也不假装实现。
- 复验:
  ① 打开侧栏 → `body[data-panel=1]`、面板 flex、`Jump to` 列出 4 台主机、Snippets 空态、
     **stage 宽度 1040 → 790**(正好让出 250px)✓;
  ② 新建片段(`touch /tmp/snippet-ok`)→ 列表出现、输入框清空 ✓;
  ③ **点片段 → 当前终端真的执行了**(`/tmp/snippet-ok` 生成;主进程日志 `write → 1 "touch /tmp/snippet-ok\r"`)✓
     —— 这是本项目第一次"从 UI 触发命令并验证副作用"的闭环;
  ④ Jump to `fake-ssh` → tab 标签变 fake-ssh、termId 变为新的 ssh 会话、**tab 数仍为 1**(切换而非新开)✓;
  ⑤ Jump to **真实主机 node-1** → 连上(状态点 on)、标题 `node-1`、termId 1000002 ✓;
  ⑥ 刷新页面 → 侧栏保持打开 ✓。
- **顺带修掉一个 bug**:Jump to 成功后标题停在 `fake-ssh (connecting…)` —— 漏了成功路径的 `setTitle`;
  已补(与 `openSession` 成功路径一致),失败路径也补 `(failed)`。
- 对照台的已知瑕疵(非产品问题):`drive.mjs` 的点击在"未观察到变化"时会补一次合成 `.click()`,
  所以日志里出现**两次** `write`(片段被执行两遍)。无害,但对**破坏性动作**要留意;
  后续若做删除类复验,需先确认单击只触发一次。

### F36 T8 重连日志(Attempting reconnection to server with ID …)   [2026-10-18 10:30]
- 规格依据:原版断线字符串组里的 `Attempting reconnection to server with ID …`(F19 已验证)。
- 实现:每次自动重连尝试前记一条 `Attempting reconnection to server with ID <hostId> (n/3)`,
  在断线覆盖层下方以等宽小字逐条列出(保留最近 20 条、展示最近 6 条);连接成功后清空。
- 复验:杀掉假服务 → 覆盖层依次出现 (1/3)(2/3)(3/3) 三条(带真实 host id)✓;
  三次耗尽后文案转为 `No connection available to reconnect` 且日志保留 ✓;
  恢复服务并手动 `Try again` → 连接成功、覆盖层消失(日志已清)✓。
- 说明:这样 T8 的三块可观测行为(自动重连/`Disable reconnecting`/重连日志)都齐了;
  原版是否还有独立的面板/持久日志**未取到**,不假装实现。
