import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 每个用例一个独立临时目录;测试结束统一清理。绝不触碰用户真实 userData / ~/.ssh。 */
export function tmpDir(prefix = "sshkit-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

export function write(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}
