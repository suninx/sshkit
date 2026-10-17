# 对照台协议(bench/PROTOCOL.md)

> 目的:让"原版 Termius 10.2.1 ↔ sshkit"的行为对照**可复现、可举证**,为 M2.5/M3 提供实测需求。
> 合规:本协议只记录**行为与接口**。不得把原版代码/资产/恢复栈产物搬进 sshkit(见 HANDOVER §0)。

---

## 1. 三层证据(优先级从高到低)

| 级别 | 手段 | 得到什么 | 依赖 |
|---|---|---|---|
| **E1** | `node bench/grab.mjs --port <CDP>` | 逐窗口 PNG + DOM + 精确几何 | 仅需 CDP(已实测可用) |
| **E2** | `screencapture -x -R x,y,w,h` | 整屏/分区像素 | 无需授权,但**会瞬时失败**(显示器睡眠/锁屏) |
| **E3** | 人工观察 | 交互手感、动效、延迟 | 你本人在场 |

E1 是主通道:它绕过 REA 的 http/https 源策略(REA 的 `capture_web_screenshot` 对 `file://` 目标实测返回
`target_not_allowed`),也不需要"屏幕录制"授权。

## 2. 开台 / 抓证据 / 收台

```sh
bash bench/preflight.sh                 # 体检(只读,不起 GUI)
bash bench/up.sh                        # 双开 + sshkit 自动与原版同尺寸并排
node bench/grab.mjs --port 9222 --url-match primary --out a.png --dom a.html   # 原版:图+DOM
node bench/grab.mjs --port 9223 --out b.png --dom b.html                       # sshkit:图+DOM
node bench/grab.mjs --port 9222 --eval-file bench/probes/ui-skeleton.js        # 结构化 UI 骨架
node bench/grab.mjs --port 9222 --eval 'document.querySelectorAll("button").length'   # 任意取值
node bench/drive.mjs --port 9222 --testid new-tab-button --tag t2-newtab        # 点击(会改界面状态)
node bench/drive.mjs --port 9223 --insert-file /tmp/cmd.txt --enter --tag t1-x  # 往终端投入同一串命令
python3 bench/probes/ansi-palette.py A.png A.json B.png B.json                  # 逐格比对调色板/字体度量
bash bench/down.sh                      # 收台(路径锚定,不误杀别的应用)
```

`grab.mjs` 只读;`drive.mjs` 会**改动**对面状态(点击/打字),故两者分开,且每步都存 before/after 截图+DOM。
投命令一律用 `--insert-file`(整串插入):逐键打字实测会吞 `\`,且字母键码若用小写码会撞 VK_F1..F12。

端口约定:原版 **9222**,sshkit **9223**(可用 `TERMIUS_CDP_PORT` / `SSHKIT_CDP_PORT` 覆盖)。

## 3. 硬约束(全是实测踩出来的,别再试错)

1. **`ELECTRON_RUN_AS_NODE=1` 在本机全局导出**。不清掉它,任何 Electron 应用的 main.js 都会以纯 Node 执行:
   原版**静默 exit 0**(看起来像"打不开"),sshkit 报 `app.getPath` undefined。`up.sh`/`down.sh` 已在子进程清除;
   手工起应用请用 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`。
2. **Electron 未实现 `Browser.setWindowBounds`**(回 `-32601 wasn't found`)→ CDP 能**读**窗口几何
   (`screenX/screenY/outerWidth/outerHeight`),**不能移动**窗口。因此:sshkit 侧靠 `SSHKIT_BENCH_BOUNDS`
   自摆(见 `src/main/main.ts` 的 `benchBounds()`),原版侧需要你手动拖一次。
3. **"辅助功能"未授权**(`-25211`)→ AppleScript 无法操作窗口。若想全自动摆位:系统设置→隐私与安全性→
   辅助功能→勾选 `DeepSeek Harness`。**不给也不阻塞**(sshkit 自摆 + 原版拖一次即可)。
4. **原版有登录墙**:干净档案下原版停在 "Welcome to Termius" 登录页,进不到终端/SFTP/转发界面。
   要做功能对照,必须先登录(见 FINDINGS F1)。
5. **原版 argv 严格**:真实 Electron 模式下 `--remote-debugging-port` 是**认**的(实测 CDP 正常开);
   但不要给它传它不认识的开关(Node 模式下会 `bad option: ...` 直接退出)。

## 4. 标准对照流程

1. **一次只问一个问题**(例:"新建 Tab 的默认标题是什么")。
2. 双侧**同一串动作**:能用 CDP 驱动的就脚本化(`capture_browser_scenario` 需 http/https,file:// 请用
   `grab.mjs` + 手工点击)。
3. **同时刻抓证据**:两侧各一张 E1 PNG + DOM,存进 `bench/sessions/<时间戳>-<标签>/`。
4. **量化差异**:把两张 PNG 交给 REA 的 `compare_web_screenshots`(吃 `sha256/bytes/media_type/data_base64`),
   得到 changed-pixel 比例——比"看着差不多"硬。
5. **记进 `bench/FINDINGS.md`**(模板见 §6),带证据路径与时间戳。
6. **回填蓝图**:把结论写进 `../termius-rea/docs/blueprints/` 对应篇(跨仓写入要显式 workdir + 单独 commit)。

## 5. 特性对照清单

**蓝图状态**一列是实测结论:HANDOVER §7 声称"端口转发、快捷键、多 Tab 的对照细节均在 blueprints",
**实测为假**——三者在 7 篇蓝图里 **0 命中**,只有零散原料。所以这几项要先"测出规格"再实现。

| # | 特性 | 观察点 | 我方实现 | 蓝图状态 |
|---|---|---|---|---|
| T1 | **终端渲染/主题/字体** | 默认配色、光标、字号、滚动回看 | `renderer/app.ts` + `renderer/themes.ts` | ✅ **已复刻(F13/F22)**:字体同文件/14px、格 8×18、底色与默认前景、16 色 `Δ=0`、canvas 四层渲染器;配色方案 **64 套**(逐字取自原版 `colorSchemesArray`)、字号 4–40、字体选择,均可切换并持久化,chrome 随主题。**复验**:切主题后终端底色像素精确变为 #100f0f、tab 条同步;字号经 pty 行列验证(14→128×37 / 20→85×24 / 30→57×17,且 128×37 与 8×18 独立互证)。**未做**:主题选择器视觉形态未测(我方为自设计列表,位置在终端标题栏)、字体仅随包 1 族(原版 12 族);界面浅色主题见 F37(自设计) |
| T2 | **多 Tab / 分屏** | Tab 标题规则、新建/关闭、分屏入口、拖拽排序 | `renderer/app.ts`(tab 模型)+ `index.html` | ✅ **已复刻主体(F14/F24)**:多会话 tab、活动/会话态配色、关闭在左、`Cmd+T/W/Shift+[ ]`、`+` 直接新建、新 tab 落地页;并补齐**拖拽重排**(左半/右半插入 + 指示线)、**右键菜单**(Rename/Duplicate/Close,取有据可查项)、**重命名**(内联输入,原版动作名 `SINGLE_TERMINAL_TAB_RENAMED`)、**复制**(按类型分派)。**未做**:菜单完整项(文案走翻译表取不到)。工作区视图(F33,竖排 tab 栏 + 持久化)与分屏/广播(F30/F31)均已实现并复验。分屏(`Split horizontally`,F30)与广播(`Broadcast`,F31)已实现并复验:两格几何正确、广播开时同一条输入写到两个会话(off +1 / on +2) |
| T3 | **端口转发** | 本地/远程/动态转发 UI、规则按主机持久化、连接后状态 | `main/forward.ts` + `renderer/fwd.ts` | ✅ **已复刻并复验(F17/F21)**:面板 + 四步向导(文案逐字)、规则按主机持久化、状态与连接计数、启动/停止/删除;引擎支持 local/remote/dynamic(内建 SOCKS5)。**复验**:-L/-D 取回远端 banner;-R 用「-L→node-1:19090→-R→本机 19091」环路验证,收到 `BANNER-1-OK`。**未做**:无(F39 已补「规则编辑复用同一向导」并逐条确认向导文案;此前记的 `Import`/分组经实测为**臆测** —— 原版 `Import` 是跳转 ideas.termius.com 的外链,与端口转发无关,已从清单删除;仅 Remote 型第二步的一句提示语为自拟,已标注) |
| T4 | **快捷键** | 新建/关闭 Tab、复制粘贴、清屏、搜索 | `renderer/keys.ts` + `main/main.ts`(剪贴板 IPC) | ✅ **已复刻主体(F16/F25)**:20 条 Mac 键位逐条照抄自原版 `shortcut_schemes`,11 条已接实体行为;另从原版**主进程 View 菜单**补齐字号快捷键(`Cmd+=`/`Cmd+-` 增减,`Reset` 无加速键),剪贴板走主进程,搜索用 xterm 官方 addon;未实现的 8 条显式提示而非静默。**复验**:字号 `Cmd+=`×3 → 14→17(pty 102×29)、`Cmd+-`×2 → 17→15(pty 114×35)。**未做**:串口(`Serial`)已记为**硬桩**(需串口原生依赖与真实设备,本项目不引入)。侧栏面板(F35:`Jump to` + `Snippets`,可开可关并持久化)已实现并复验;工作区视图与广播模式见 F31/F33 |
| T5 | **SFTP** | 双栏结构、目录浏览、上传下载、拖拽、权限/时间列 | `renderer/sftp.ts` + `main/sftp.ts` | ✅ **已复刻主体(F15/F23)**:常驻 tab、左右双栏、列头 Name/Date Modified/Size/Kind、两行式行(名+权限串)、`..` 首行、默认隐藏点文件、未绑定时的空态、Actions 菜单;并补齐**列头点击排序**(默认不排序=原版 `sortBy:null`、每栏独立、ASC▲/DESC▼ 仅当前列)与**多选**(Cmd 切换 / Shift 范围 / Cmd+A 全选 / Esc 清除,菜单随数量变 `Delete N items`)。**未做**:无(F37 已补浅色界面主题:28 处硬编码覆盖层变量化 + SFTP 配色;界面浅色值为**自设计**,原版界面调色板取不到) |
| T6 | **Known Hosts** | 首连提示、指纹变更拒绝、已知主机管理 | `main/knownhosts.ts` + `renderer/knownhosts.ts` | ✅ **已复刻(F18)**:文案逐字取自原版组件自身(首连 `Are you sure you want to connect?` / 变更 `The fingerprint for <host> has changed` + `Replace`/`Add as new`),首次连接改为**询问式**(不再静默 TOFU,120s 无应答按拒绝);Known Hosts 视图(列表/指纹/删除/空态)。**隔离复验**:本地假 ssh 服务触发→Add and continue→`~/.ssh/known_hosts` 实增 `[127.0.0.1]:2222`。**未做**:无(F27 走通 `Replace`、F29 补 `Import Known Hosts`、F32 补多选与批量删除) |
| T7 | **主机簿** | 分组、排序、搜索、标签 | `renderer/hosts.ts` | ✅ **已复刻(F20/F26)**:搜索(占位符逐字 `Find a host or ssh user@hostname...`,按 名称/主机名/用户名)、四种排序(`A-z`/`Z-a`/`Newest to oldest`/`Oldest to newest`)、分组头字典序 + 组内按所选排序;并补齐**标签**(`Tags` 字段 + 行内芯片 + `Filter by tags` 复选过滤 + `Clear filters`)与**布局切换**(原版 `Change layout` → `List`/`Grid`,已实现并持久化)。**未做**:无(F32 补行内 `Remove tag`、F38 补标签颜色与自动补全;颜色为**自设计**,原版数据形态取不到) |
| T8 | **断线/重连** | 断线呈现、重连入口、退出码 | `renderer/app.ts` + `main/ssh.ts` | ✅ **已复刻并复验(F19)**:断线覆盖层 + 全局断开条(文案逐字 `Initiating reconnection...`/`1 session is disconnected`/`Force reconnect terminals`/`Close all disconnected terminals`/`No connection available to reconnect`/`Try again`)、自动重连(3 次退避)、reload 收孤儿会话。**干净环境复验**:首连询问→pin;杀服务→覆盖层+条+重试置灰;耗尽→`No connection available to reconnect`+`Try again` 可点;恢复服务→Force reconnect 成功(覆盖层/条消失、状态回 on、服务端收到新 shell)。**未做**:无(F28 补 `Disable reconnecting`、F36 补重连日志;自动重连本体见 F19) |

## 6. 记录模板(追加到 FINDINGS.md)

```md
### F<n> <一句话结论>            [YYYY-MM-DD HH:MM]
- 问题:<要回答什么>
- 动作:<双侧各做了什么,越具体越好>
- 证据:<session 目录>/<文件>.png(+ .html)
- 结果:<原版怎样 / sshkit 怎样 / 差在哪>
- 影响:<要改什么,或"无需改">
```

## 7. 量化 diff 用法(可选但推荐)

```js
// 把 grab.mjs 产出的两张 PNG 塞给 REA compare_web_screenshots:
// before/after 各要 { sha256, bytes, media_type:"image/png", data_base64 }
// 返回 changed-pixel 比例与通道差 —— 主题微调/字体差异这关就靠它把"感觉"变成数字。
```
