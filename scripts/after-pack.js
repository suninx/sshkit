/**
 * electron-builder 的 afterPack 钩子。
 *
 * macOS 特有:Electron 官方二进制自带 adhoc 签名,但我们换了 Resources/app.asar、
 * 塞进了 node-pty/keytar 的 .node 之后,**bundle 的封印就失效了**:
 *   spctl -a -vvv -t exec sshkit.app
 *   → code has no resources but signature indicates they must be present
 * 这类产物虽然能被终端直接拉起,但用户双击/经 quarantine 传播时更容易被报成"已损坏",
 * 而且 .node 原生模块在 Apple Silicon 上没有有效签名(内核要求所有可执行页都有签名)。
 *
 * 修法成本为零:本地 adhoc 重签(不需要 Apple 开发者账号)。
 *   codesign --force --deep --sign - sshkit.app
 * 注意:adhoc **不等于**公证,首次打开仍会弹"未认证开发者",用户仍需右键打开 /
 * xattr -dr com.apple.quarantine。真正的零摩擦需要 Developer ID + 公证(付费)。
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  try {
    /* --deep 不会覆盖 Resources/app.asar.unpacked 里的散装 .node(它们是真正的 Mach-O),
       Apple Silicon 内核要求每个可执行页都有签名 —— 先把它们逐个签掉,再签整个 bundle。 */
    const nodes = [];
    (function walk(dir) {
      for (const ent of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile() && ent.name.endsWith(".node")) nodes.push(full);
      }
    })(appPath);
    for (const n of nodes) {
      execFileSync("codesign", ["--force", "--sign", "-", n], { stdio: "inherit" });
    }
    if (nodes.length) console.log(`[afterPack] 已签名 ${nodes.length} 个原生模块`);
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
    console.log(`[afterPack] adhoc 重签完成: ${appName}`);
  } catch (err) {
    // 不静默失败:签名失败要显式暴露,否则又会回到"看起来能跑但 quid 坏"的状态
    console.error("[afterPack] adhoc 重签失败:", err?.message ?? err);
    throw err;
  }
};
