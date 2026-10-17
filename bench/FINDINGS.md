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
