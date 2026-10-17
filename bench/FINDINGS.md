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
