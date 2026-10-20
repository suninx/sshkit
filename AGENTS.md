# AGENTS.md — sshkit 代理作业约定

> 面向在本仓工作的 AI 代理(以及新加入的人)。**先读本文件,再读 `HANDOVER.md`**(项目使命、里程碑账目、坑位清单),对照台细节见 `bench/PROTOCOL.md`,原版实测结论见 `bench/FINDINGS.md`。
> 本文件只写"怎么做",不重复上面三份的历史。

---

## 0. 铁律(违反即返工)

1. **只复刻行为与架构,不搬资产与代码**。研究对象的闭源二进制(`termius.node`、`moshclient.node`)、打包资产、反汇编/恢复栈代码**不得进入本仓、不得组装进产物**。
2. **不改动研究对象的数据**。原版 Termius 只允许"看"(CDP 只读、截图、DOM 读取);不得点它的设置、登录、发消息给它。
3. **凭据只写不读**。渲染层永远拿不到已保存的密码(`creds:put` 写,读只在主进程连接时发生)。不要"顺手"加 read API。
4. **不往仓库里塞证据文件**。截图/日志/导出的 DOM 归 `bench/sessions/`、`bench/.run/`(均已 gitignore,可能含个人内容)。
5. 除非用户明确要求,**不新起服务、不改全局环境变量**(尤其 `ELECTRON_RUN_AS_NODE`,见 §4)。

### 0.1 测试铁律(用户点名,不可协商)

6. **测试锁"期望行为",不锁"当前行为"**。写用例前先问:这是它**应该**做的,还是它**碰巧**在做的?
   拿当前实现当答案抄一遍,等于给 bug 上锁。
7. **用例失败先定性,再动手**:
   - 是**产品错** → 改产品(测试不动);
   - 是**期望写错** → 改测试,并在提交信息里写明"原来期望 X 是错的,正确语义是 Y,依据是 Z"。
   绝不允许为了让红变绿而**放宽断言、删用例、加 skip、把失败路径塞进桩里抹掉**。
8. **测试替身必须忠实**:只实现真实存在的 API,签名与返回值照实;不该被调用的方法
   要显式抛错("not stubbed"),而不是悄悄返回一个合理值把问题掩盖过去。
9. **每个修掉的 bug 留一条回归用例**(测试名里写清"回归:"),否则这个 bug 会回来。
10. **覆盖率是副产品,不是目标**。为了数字好看去写无断言/重复断言的用例,与不写等价。

## 1. 仓库地图

```
src/main/      主进程:main.ts(窗口/IPC/菜单) ssh.ts(会话+known_hosts) sftp.ts
               forward.ts(端口转发) store.ts(主机簿) settings.ts(应用设置)
               keystore.ts(keytar 凭据) knownhosts.ts snippets.ts pty.ts
src/preload/   冻结桥(contextBridge.exposeInMainWorld("sshkit", …))—— 渲染层唯一通路
src/renderer/  app.ts(tab/会话/分区屏/外观面板) hosts.ts(主机列表与表单)
               sftp.ts(双栏) knownhosts.ts keys.ts fwd.ts themes.ts index.html(全部样式)
src/shared/    主/渲染共用:i18n.ts(中英文目录) host.ts sftp.ts forward.ts knownhost.ts
bench/         对照台(见 PROTOCOL.md);FINDINGS.md 是原版实测结论
dist/          构建产物(勿手改)
```

安全姿态不可回退:`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`、桥单文件白名单。

## 2. 命令

```sh
pnpm install                      # 需要时
pnpm exec tsc --noEmit            # 类型关:每轮必须过
pnpm run build                    # esbuild → dist/
pnpm start                        # build + electron .(前台)

# GUI 启动(带调试端口;本机 ELECTRON_RUN_AS_NODE 是全局导出的,必须清掉)
nohup env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron . \
  --remote-debugging-port=9223 --user-data-dir="$HOME/Library/Application Support/sshkit" \
  > bench/.run/sshkit-live.log 2>&1 &

# 测试与打包(工程化)
pnpm test                         # 单元/集成(vitest,59+ 用例)
pnpm run test:coverage            # 覆盖率(阈值是实测棘轮,只升不降)
pnpm run test:e2e                 # 端到端(Playwright 驱动真实 Electron,临时 user-data-dir)
pnpm run test:all                 # typecheck + unit + build + e2e
pnpm dist                         # 打包 → release/(zip)
pnpm run dist:dir                 # 只出 .app(调试打包问题用)
pnpm run dist:dmg                 # 用系统 hdiutil 生成 DMG

# 对照台(见 bench/PROTOCOL.md)
bash bench/up.sh / bash bench/down.sh --keep-termius
node bench/grab.mjs --port 9223 --out /tmp/a.png          # 截图
node bench/grab.mjs --port 9223 --eval 'document.title'   # DOM 探针
node bench/drive.mjs --port 9223 --key "Meta+,"
```

端口:**9223 = sshkit**;**9222 = 原版 Termius**(只读);55862 是宿主 GUI,别碰。

## 3. 验证纪律(本项目 90% 的返工都出在这)

- **探针优先于猜测**:界面问题一律用 CDP 读真实 DOM/几何/样式,不靠"看代码应该对"。
  短命状态:触发 → 等 ~150ms–3s → 再读(菜单/弹窗会被 click-outside 立刻关掉)。
- **改代码要断言**:任何批量替换(正则/sed/python)都要对匹配串 `assert`,本项目已多次出现
  "补丁静默没打上"。改完**必须重新验证**,不能因为脚本 exit 0 就当落地。
- **失败路径必须响**:不许把错误吞成空状态(反例:SFTP 曾把"通道开失败"渲染成"未连接")。
- **收工前四项**:`tsc --noEmit` 过、`build` 过、在运行中的应用里实测到目标行为、
  主进程日志 `[renderer]` 新增 **0** 条错误(`grep -c '\[renderer\]' bench/.run/sshkit-live.log`)。
- **颜色/像素口径**:截图取样会有 ≈1/255 的压缩漂移,比较时留容差;量几何用 DOM 的 `getBoundingClientRect`。

## 4. 已知坑(完整清单在 `HANDOVER.md` §5)

- 起 GUI 必须 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`,否则 Electron 退化成纯 Node 跑 main.js(表现为"窗口打不开")。无头冒烟脚本反过来**故意**要 `ELECTRON_RUN_AS_NODE=1`。
- esbuild externals 必须含 `electron, node-pty, keytar, ssh2, cpu-features`。
- `pnpm run build` 脚本只跑 esbuild,**不含类型检查**;`dist/` 陈旧会导致"改了没生效",先看 `pnpm exec tsc --noEmit` 再说。
- 主进程改动必须**重启**应用才生效;纯渲染层改动 `location.reload()` 即可(会话会断)。
- 原版对照:`Browser.setWindowBounds` 未实现(不能移窗)、辅助功能未授权(AppleScript 不能操作窗口)。

## 5. i18n 约定(2026-10 起)

- 所有用户可见文案走 `src/shared/i18n.ts` 的 `tr(key, vars?)`;**英文是基准表**,中文必须是完整映射(缺键会被 `audit()` 报出来)。
- 静态标记用 `data-i18n` / `-placeholder` / `-title` / `-aria`;动态生成的在渲染处调 `tr()`。
- **不翻译**:产品名词(`Vaults` / `SFTP` / `Snippets`)、配色方案名、示例占位符(`prod-1` / `root`)、数据本身(文件名、权限串)。
- 语言偏好存 `userData/settings.json`(主进程与渲染层共用一份),入口:⌘, / 菜单栏「偏好设置…」/ 工具条齿轮。
- 新增语言时:补 `catalogs` 与 `resolveLocale`,并跑一次双向扫描(英文模式查中文残留,中文模式查英文残留)。

## 6. 提交与分支

- 提交信息用中文,**首行 `type(scope): 摘要`**,正文写"改了什么 + 为什么 + 实测结果";带多行/含引号时用 `git commit -F -` 读 heredoc,别用 `-m "…"`。
- 功能改动走分支(`feat/…`、`fix/…`),完成后 `git merge --no-ff` 回 `main` 再推;`tsc`/`build`/实测不过不合并。
- 文档与证据分离:代码与文档进 git;截图/日志留在 gitignore 目录。

## 7. 完成定义(DoD)

一次改动只有在以下全部成立时才算完成:

1. `pnpm exec tsc --noEmit` 与 `pnpm run build` 均通过;
2. 在运行中的应用里**实测**到预期行为(附截图或 DOM 探针输出);
3. 渲染层与主进程日志无新增错误;
4. 与原版对照的界面改动有**实测依据**(`bench/FINDINGS.md` 里的条目或新测量值),不是凭印象;
5. 已提交,信息能让人看懂"为什么"。
