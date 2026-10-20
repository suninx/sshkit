import { defineConfig } from "vitest/config";

/* 单元/集成测试。默认 node 环境;需要 DOM 的用例在文件头写
   `// @vitest-environment jsdom` 即可(jdom 已装)。
   覆盖目标只看"纯逻辑层"(src/shared + src/main 的可测模块 + 渲染层纯函数),
   不追求 UI 的语句覆盖 —— UI 由 test/e2e 的 Playwright 覆盖。 */
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/shared/**/*.ts", "src/main/**/*.ts", "src/renderer/*.ts"],
      exclude: ["src/renderer/themes.ts", "src/renderer/fonts/**"],
      reporter: ["text-summary", "html", "lcov"],
      reportsDirectory: "test/.coverage",
      /* 阈值是"棘轮下限":等于当前实测值(留 1pt 余量),只许升不许降。
         不是目标,也不代表整体质量 —— 渲染层主要靠 test/e2e 的 Playwright 覆盖,
         它不进入 v8 覆盖率统计,所以这里的百分比只反映**单元/集成测试**覆盖的逻辑层。 */
      thresholds: { lines: 14, functions: 12, statements: 13, branches: 12 },
    },
  },
});
