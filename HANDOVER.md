# sshkit 交接文档(请先读本文件再动工)

> 写于 M2 收尾。换会话时:先 `git log --oneline`(两个仓),再回到本文扫一遍,即可无损接手。

---

## 0. 项目使命与合规边界(不许漂移)

- **使命**:从一款商业 SSH 终端(termius 10.2.1 mac-arm64)的行为研究中,产出**自研等价、可裁剪**的本地优先 SSH 客户端(学习用途)。
- **合规红线**:
  - 行为/架构/特性面的**复刻=OK**;
  - 对方的闭源二进制(`termius.node` Botan 栈、moshclient.node)、资产、恢复栈反汇编代码**禁回灌自家产品**;
  - `~/workspace/termius-rea/recovered-sources/wakaru` 是**去类型/改名的不可运行研究快照**,只作对照阅读,不得组装发行;
  - 供应商原样使用的开源件(xterm、node-pty、keytar、mosh)→ 我们**同款照用** = 合法的“按人家来”。

## 1. 双仓地图

| 仓 | 角色 | 关键入口 |
|---|---|---|
| `~/workspace/termius-rea`(git,首提交 `2da18b4`) | 研究档案:REA 管线 + 恢复源 + 矩阵 | `README.md` 总装 · `docs/architecture.md` · `docs/blueprints/01..06` · `analysis/SUMMARY.md`(全指针化) · `analysis/native-inventory.md`(termius.node 2,159 符号/1,065 Botan 类) |
| `~/workspace/sshkit`(git) | **产品本体**(M0-M2) | 本文 + `docs/blueprints 引用见 §7` |

两仓均为本地 git(用户将自行决定何时挂远程)。**每个里程碑一次 commit**,先过再动。

## 2. sshkit 技术栈速查

- Electron **44.8.0** · esbuild 0.28 · **TypeScript 7.0.2**(⚠️ `moduleResolution:node10` 已除名,用 `node16`;esbuild 出 CJS)
- `@xterm/xterm@6.0.0` + addon-fit · node-pty 1.1.0 · ssh2 1.17(+@types) · keytar 7.9
- 包管理 **pnpm 11.21**:`.npmrc node-linker=hoisted`;构建脚本白名单在 `pnpm-workspace.yaml onlyBuiltDependencies`(新原生件要补录后 `pnpm approve-builds --all`);⚠️ pnpm 11 无 `--no-fund/--no-audit` 旗标
- **安全姿态**(全程反着研究对象的硬伤来):`contextIsolation:true` + `sandbox:true` + `nodeIntegration:false`;桥 `contextBridge.exposeInMainWorld("sshkit", …)` 单文件白名单;凭据**只写不读**(渲染层拿不到已存密码)
- CSP(`src/renderer/index.html`):`script-src 'self'` 锁死;**`style-src 'self' 'unsafe-inline' 必须保留**——xterm.js 用逐节点 inline style 上色,style 内联禁=黑字事件(M0.1 教训)

## 3. 里程碑账目(git 序)

| commit | 内容 |
|---|---|
| `904e607` M0 | Electron 瘦壳 + xterm + node-pty 本地终端;esbuild 三管线;TS7 `node16` 修 |
| `3dd9e02` M0.1 | CSP style-src 'unsafe-inline'(black-text 排障:main 的 `console-message` 转发 + DOM 探针;探针已摘) |
| `5c467c7` M1 | 主机簿(JSON 原子写 userData/hosts.json)+ keytar(KC `sshkit`:host:\<id\>)写只读 + ssh2 会话**同管线复用**(id 空间 PTY 自 1 起 / SSH 自 1,000,001 起,四通道 `terminal:data/write/resize/exit`)+ 双栏 UI(Local shell 伪主机项) |
| `0b136ad` M2 | SFTP 双栏(fastPut/fastGet + step 进度事件 `sftp:progress`,远端列/建/删/改名;本地 fs 同型控制器)+ known_hosts TOFU 钉扎(OpenSSH 兼容格式,复用 `~/.ssh/known_hosts`) |
| `3acbef0` fix | **ssh2 `handshake` 事件不含 key**;正确钩子是 `connectConfig.hostVerifier(key, verify)`(出处 ssh2/lib/client.js:281)。改用 hostVerifier;blob 头自解析算法名(keyTypeFromBlob);拒绝必带原因走横幅 |
| `f75469b` | `scripts/smoke-ssh.js`:无头 E2E(固定 `ELECTRON_RUN_AS_NODE=1` 起电子,普通 node 因 ABI 缓存 keytar 载不进);已跑通 PASS(verifier 收到 ed25519 blob→与 known_hosts 全等比对 MATCHES→auth OK) |
| `520ca35` | **A 对照台**(`bench/`):preflight/up/down/cdp/shot/grab + PROTOCOL + FINDINGS;产品侧唯一改动=`main.ts` 的 `SSHKIT_BENCH_BOUNDS` 窗口钩子。实测:原版 CDP@9222(3 targets)、sshkit CDP@9223、靶机 193 |

用户实测:LAN Linux(192.0.2.32)M1 已连成功;M2 修复后**尚未手动复测连接**(但 smoke 已程序化验证)。

## 4. 日常命令

```sh
cd ~/workspace/sshkit
pnpm run build          # esbuild → dist/
pnpm exec tsc --noEmit  # 类型关(每轮必过)
pnpm run rebuild:pty    # 原生件按 Electron ABI 重编(新加原生件: -w keytar,ssh2,node-pty 名单)
pnpm start              # build + electron .

# 杀/起(后台)
pkill -f "sshkit/node_modules/.pnpm/electron"; nohup pnpm exec electron . > /tmp/sshkit-run6.log 2>&1 &

# 无头 SSH 冒烟(不带 UI 验 known_hosts+凭据链)
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke-ssh.js [ip]

# 对照台(A;详见 bench/PROTOCOL.md)
bash bench/preflight.sh                 # 体检(只读,不起 GUI)
bash bench/up.sh                        # 双开 + sshkit 自动与原版同尺寸并排
node bench/grab.mjs --port 9222 --url-match primary --out a.png --dom a.html   # 原版证据
node bench/grab.mjs --port 9223 --out b.png --dom b.html                       # sshkit 证据
bash bench/down.sh                      # 收台(路径锚定,不误杀别的应用)

# 排障:renderer console 已转发到主进程 stdout(见 main.ts console-message 段);探针法=M0 用法
```

## 4.5 明确不做的功能(别再加回来)

- **串口 / Serial**:2026-10-22 用户决定**不做**,已移除工具栏按钮、`serialConnection` 快捷键
  (Cmd+Alt+S)、侧栏 Serial 分区说明与相关 i18n 文案。原版有、我们没有,这是**产品决策**不是缺失。
  需要连 Console 的场景,用"本地终端"跑 `screen /dev/tty.usbserial-XXXX 115200` 即可。

## 5. 已知坑位清单(新会话先看这个)

1. **esbuild externals 必含原生件**:`electron, node-pty, keytar, ssh2, cpu-features`(否则 `.node` 打包报 no loader)。
2. **pnpm 11 新原生件**:补 `pnpm-workspace.yaml` 白名单 + `pnpm approve-builds --all`,再 `pnpm i` 一次让脚本跑完。
3. **keytar/普通 node**:ABI 不通,一律走 `ELECTRON_RUN_AS_NODE=1 + electron 二进制`。
   ⚠️ 反向坑(2026-10-17 实测):**本机 `ELECTRON_RUN_AS_NODE=1` 是全局导出的**。凡起 **GUI** 应用必须
   `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`,否则 Electron 一律退化成纯 Node 跑 main.js —
   原版**静默 exit 0**(看起来像"打不开"),sshkit 报 `app.getPath` undefined。`bench/up.sh` 已内建清除。
   (上面这条无头冒烟是**故意**要 `=1` 的,两回事。)
4. **凭据流**:仅 `creds:put` 写;读取只在 main 连接时(`keystore.getCreds`),渲染层没有 read API——别“顺手”加 read。
5. **known_hosts**:exact+逗号匹配、`|1|` HMAC-SHA1 哈希行可读;**通配符 pattern 未支持**;目录传输未支持(单文件);连接中密码弹窗未做(靠表单存 Keychain)。
6. **ssh2 事件信用源码**:handshake 无 key;`fastPut/fastGet` 才有 step 进度;`NegotiatedAlgorithms` 的 typings 说得对。
7. 用户的 LAN 机:**192.0.2.32 与 192.0.2.92 主机密钥相同**(克隆镜像迹象)、192.0.2.10 为 ecdsa——不是劫持,是镜像。三台 ssh-keyscan 均与 known_hosts 一致。
8. **对照台相关**(细节 `bench/PROTOCOL.md` §3):
   - `Browser.setWindowBounds` 在 Electron **未实现**(-32601)→ CDP 只能**读**窗口几何
     (`screenX/screenY/outerWidth/outerHeight`),**不能移窗**。sshkit 靠 `SSHKIT_BENCH_BOUNDS` 自摆;原版手动拖。
   - **"辅助功能"未授权**(-25211)→ AppleScript 不能操作窗口。想全自动:给 `DeepSeek Harness` 勾上。
     探针要问"进程窗口数"这种真 UI 查询;问 `frontmost` 会**假阳性**(不需授权)。
   - `screencapture` 会因显示器睡眠**瞬时**失败(`could not create image from display`)——是瞬时,不是授权问题;
     主证据通道用 CDP 逐窗口截图。
   - REA 的 `capture_web_screenshot` 按 http/https 源做策略,对 Electron 的 `file://` 页返回 `target_not_allowed`
     → 用自建 `bench/grab.mjs`(零依赖)。
9. **原版启动的坑**:干净档案下原版会停在 **"Welcome to Termius" 登录墙**(进不到终端);二进制本身完好
   (asar 与 DMG 逐字节一致、公证有效)——别再往"包被改坏"方向查。

## 6. 教训归档(用户点名要保的)

- 家规出处:问题“复刻怎么还会犯这种错”→ 答案分三层:
  - 产品语义层(做什么):蓝图已覆盖,未犯错;
  - 实现琐事层(某库怎么用):复刻档案**管不到**,唯一解=对被选依赖读包源码(把 node_modules 当它的“逆向档案”);
  - 过程纪律层(真病根):tsc `does not exist` 报错**先取证据再 cast**;失败路径必须响(本次静默 `client.end()` 雪上加霜)。
- M0 CSP 教训:安全收紧以**组件运行机制**为准(xterm=inline style 染色),写凶≠安全;探针实测再定案(本仓库调试风格保留:console 转发+小探针)。

## 6.5 双工作区约定(后续会话照此)

- **新会话从 `~/workspace/sshkit` 目录打开**(主战场 95% 的写入在这);`termius-rea` 只作阅读牵引用绝对路径/相对上一级读取(`../termius-rea/docs/blueprints/…`)。
- 两仓保持**独立 repo、不合并**:git 历史、远端策略分家——`sshkit` 将来可整仓公开;`termius-rea` 含研究对象参照与恢复快照,**永久只留本地**。
- 跨仓写入(给研究仓补笔)可做但要显式 workdir + 单独 commit(本仓文档补充即此惯例)。

## 7. 蓝图对照(重建路线的“需求文档”)

`termius-rea/docs/blueprints/`:`01-terminal.md`(终端/远端会话)·`06-ui.md`(主题/按键/UI 骨架)为当前常用;其余见目录。

⚠️ **更正(2026-10-17 实测)**:**端口转发、快捷键、多 Tab 三块在 7 篇蓝图里 0 命中**
(检索 `forward|转发|隧道|tunnel|proxy|socks|tab|快捷键|keybind|accelerator`),原表述"细节均在那里"有误。
这三项属**需求缺口**,只有零散原料:`analysis/native-inventory.md:89`(`SshDynamicPortForwarding` 19 符号)、
`recovered-sources/wakaru/ui-root/INDEX.md:128,226,240,263,285`。做 M2.5/M3 前先用对照台**测出规格再补蓝图**
(清单见 `sshkit/bench/PROTOCOL.md` §5)。

原版"可运行"亦需补一句:干净启动的前提是清掉 `ELECTRON_RUN_AS_NODE`(见 §5.3),清掉后连 CDP 都能开。

## 8. 下一步(用户待选)

- **A. 并排对照台**:**✅ 设施已建成**(commit `520ca35`,`bench/`;协议 `bench/PROTOCOL.md`,实测 `bench/FINDINGS.md`)。
  已验证:双开、sshkit 自动同尺寸并排、双侧 CDP 取证(逐窗口 PNG+DOM)、收台。
  **当前卡点(F1)**:原版干净档案停在 **"Welcome to Termius" 登录墙**,进不到终端 → 需**你登录一次**才能做
  终端/SFTP/转发对照。登录后按 PROTOCOL §4 逐项对照,建议先做 T1/T5/T6(我方已有实现可比)。
- B. wakaru 恢复树“拼装自证失败”实验(约 1 天,预期不通,价值=实证)。
- **C. M2.5 端口转发**(`ssh2.forwardOut` 本体小;真工作量在挂载点=**Tab 系统**;建议与 M3 一起):多 Tab + 主题/字体/快捷键 + 转发表 × 每主机规则。
  ⚠️ 按 §7 更正:Tab/转发/快捷键**目前无蓝图** → 第一件事是用对照台测出规格、补蓝图,再写代码。
  - M4 mosh 桥(可选)· M5 electron-builder 打包 + GH Releases 更新源。
- 用户

## 9. 快速接手话术(新会话第一条照这个说)

> 先读 `sshkit/HANDOVER.md`,然后 [A|B|C]。
