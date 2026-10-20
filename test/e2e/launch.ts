import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
  close: () => Promise<void>;
}

/** 启动构建后的 Electron 本体,用**临时 user-data-dir** 与用户真实数据完全隔离。 */
export async function launchApp(): Promise<Launched> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-e2e-"));
  const env = { ...process.env } as Record<string, string>;
  /* 本机 ELECTRON_RUN_AS_NODE 是全局导出的(见 HANDOVER §5):起 GUI 必须清掉,
     否则 Electron 退化成纯 Node 跑 main.js,窗口永远不出来。 */
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  /* Linux CI(容器内)没有用户命名空间,Chromium 的沙箱会直接让进程起不来;
     只在 CI 下关掉沙箱,本地运行仍保持默认安全设置。 */
  const ciArgs = process.env.CI ? ["--no-sandbox", "--disable-gpu"] : [];
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userData}`, ...ciArgs],
    cwd: process.cwd(),
    env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector("#rail", { state: "attached" });
  return {
    app, page, userData,
    close: async () => {
      try { await app.close(); } catch { /* ignore */ }
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
