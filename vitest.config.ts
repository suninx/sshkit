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
      /* 排除项只有两类,理由如下(AGENTS §0.3):
         1) src/renderer/themes.ts —— 1600+ 行纯配色数据表,唯一函数 toXtermTheme 另有用例覆盖;
         2) src/shared/{host,knownhost,sftp,forward}.ts —— **纯类型模块**,编译后不产生任何
            运行时语句(grep 验证:0 处 const/function/class 声明),计入分母只会拉低百分比。
         字体是二进制资源,不参与统计。 */
      exclude: [
        "src/renderer/themes.ts",
        "src/renderer/fonts/**",
        "src/shared/host.ts",
        "src/shared/knownhost.ts",
        "src/shared/sftp.ts",
        "src/shared/forward.ts",
      ],
      reporter: ["text-summary", "html", "lcov"],
      reportsDirectory: "test/.coverage",
      /* 阈值是"棘轮下限":贴近当前实测值,只许升不许降(见 AGENTS.md §0.3)。
         实测(2026-10-20,326 用例):statements 89.95 / branches 78.76 / functions 88.4 / lines 94.06。
         这里取整到"留约 1pt 余量"的下限,防止后续改动悄悄降低覆盖;要提高质量就补测试,不许下调。
         仅排除纯数据表(themes.ts 的配色常量)与字体资源,理由见 AGENTS §0.3。 */
      /* 100%:用户明确要求"覆盖率目标是 100%,不能打折"。这是**下限**而不是目标 ——
         任何一行未覆盖的代码,要么补测试,要么说明它不可达并删除,不允许下调阈值。 */
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 100 },
    },
  },
});
