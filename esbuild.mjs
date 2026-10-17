import * as esbuild from "esbuild";
import { mkdirSync, cpSync } from "node:fs";

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

await esbuild.build({ entryPoints: ["src/main/main.ts"], outfile: "dist/main/main.js", ...nodeCommon });
await esbuild.build({ entryPoints: ["src/preload/preload.ts"], outfile: "dist/preload/preload.js", ...nodeCommon });
await esbuild.build({
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
console.log("build ok → dist/");
