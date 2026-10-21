import * as esbuild from "esbuild";
import { mkdirSync, cpSync } from "node:fs";

const WATCH = process.argv.includes("--watch");
/** --watch 时用 context+watch(改文件自动重建);否则一次性 build */
async function buildOrWatch(opts) {
  if (!WATCH) return esbuild.build(opts);
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  return ctx;
}
const nodeCommon = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron", "node-pty", "keytar", "ssh2", "cpu-features"],
  sourcemap: "inline",
  minify: false,
};

for (const d of ["dist/main", "dist/preload", "dist/renderer"]) mkdirSync(d, { recursive: true });

await buildOrWatch({ entryPoints: ["src/main/main.ts"], outfile: "dist/main/main.js", ...nodeCommon });
await buildOrWatch({ entryPoints: ["src/preload/preload.ts"], outfile: "dist/preload/preload.js", ...nodeCommon });
await buildOrWatch({
  entryPoints: ["src/renderer/app.ts"],
  outfile: "dist/renderer/app.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  sourcemap: "inline",
});

cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("node_modules/@xterm/xterm/css/xterm.css", "dist/renderer/xterm.css");
cpSync("src/renderer/fonts", "dist/renderer/fonts", { recursive: true });
console.log(WATCH ? "watch 模式已启动(watching src/)→ dist/" : "build ok → dist/");
