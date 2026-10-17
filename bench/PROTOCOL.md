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
| T1 | 终端渲染/主题/字体 | 默认配色、光标、字号、滚动回看 | `renderer/app.ts` + xterm 主题 | 06 部分覆盖;**F12 已实测**:字体 `Meslo 14px` vs 我方 `Menlo 13px`;行距 18 vs 15;背景 `#141728` vs `#101418`;**原版 20+ 套内置主题**、canvas 渲染 vs 我方 DOM 渲染 |
| T2 | **多 Tab / 分屏** | Tab 标题规则、新建/关闭、分屏入口、拖拽排序 | 无(单终端) | ❌ **缺**;**F11 实测落点**:原版顶部 tab 条 `Vaults\|SFTP\|+`(`data-testid=horizontal-tabs`/`new-tab-button`),且 **SFTP 是 tab**;原料 `ui-root/INDEX.md:226,240,263`(`workspaceTab*`、split terminal 文案) |
| T3 | **端口转发** | 本地/远程/动态转发 UI、规则按主机持久化、连接后状态 | 无 | ❌ **缺**;**F11 实测落点**:原版左栏一级导航项 `Port Forwarding`;原料 `analysis/native-inventory.md:89`(`SshDynamicPortForwarding` 19 符号)、`INDEX.md:128,285`(`dynamic-port-forwarding`、`"Set up port forwarding"`) |
| T4 | **快捷键** | 新建/关闭 Tab、复制粘贴、清屏、搜索 | 无自定义 | ❌ **缺**(0 命中) |
| T5 | SFTP 双栏 | 列目录字段、进度呈现、覆盖/改名交互 | `main/sftp.ts` + `renderer/sftp.ts`(M2) | 03 覆盖 |
| T6 | 认证与 known_hosts | 首次连接提示、指纹变更拒绝话术 | `main/knownhosts.ts`(M2,TOFU) | 04 覆盖 |
| T7 | 主机簿/分组 | 分组层级、排序、搜索 | `main/store.ts`(扁平 + group 字段) | — |
| T8 | 会话体验 | 断线提示、重连、退出码呈现 | `main/ssh.ts` | 01 部分覆盖 |

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
