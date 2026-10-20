import { defineConfig } from "@playwright/test";

/* 端到端:直接启动构建后的 Electron 本体(不下载浏览器)。
   每个用例用**临时 user-data-dir**,与用户真实数据完全隔离。 */
export default defineConfig({
  testDir: "test/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  /* 卡片操作按钮是 hover 才显形(与原版一致),鼠标位置在重绘后可能丢失 ——
     CI 上允许一次重试兜住这类交互波动;功能断言本身不放宽。 */
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
});
