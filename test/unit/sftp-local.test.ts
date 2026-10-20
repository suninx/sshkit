import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmDir, tmpDir, write } from "../helpers/tmp";
import { SftpController } from "../../src/main/sftp";

let dir: string;
let ctrl: SftpController;

beforeEach(() => {
  dir = tmpDir("sshkit-sftp-");
  ctrl = new SftpController(() => undefined, () => { /* no-op */ });
  write(dir, "a.txt", "0123456789");
  fs.mkdirSync(path.join(dir, "sub"));
  write(dir, ".hidden", "h");
});
afterEach(() => rmDir(dir));

describe("listLocal()", () => {
  it("列出目录内容并带 isDir/size/mode/mtime", async () => {
    const r = await ctrl.listLocal(dir);
    expect(r.path).toBe(dir);
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toEqual([".hidden", "a.txt", "sub"]);

    const a = r.entries.find((e) => e.name === "a.txt")!;
    expect(a.isDir).toBe(false);
    expect(a.size).toBe(10);
    expect(a.mode & 0o170000).toBe(0o100000);   // 普通文件
    expect(a.mtime).toBeGreaterThan(0);

    const sub = r.entries.find((e) => e.name === "sub")!;
    expect(sub.isDir).toBe(true);
    expect(sub.mode & 0o170000).toBe(0o040000); // 目录
  });

  it("支持 ~ 前缀(展开到家目录)", async () => {
    const r = await ctrl.listLocal("~");
    expect(r.path).toBe(os.homedir());
    expect(r.entries.length).toBeGreaterThan(0);
  });

  it("目录不存在时 reject(而不是返回空列表)", async () => {
    await expect(ctrl.listLocal(path.join(dir, "nope"))).rejects.toBeTruthy();
  });
});

describe("本地增删改", () => {
  it("mkdir / rename / remove 正常路径", async () => {
    const d = path.join(dir, "newdir");
    await ctrl.mkdirLocal(d);
    expect(fs.statSync(d).isDirectory()).toBe(true);

    const from = path.join(dir, "a.txt");
    const to = path.join(dir, "b.txt");
    await ctrl.renameLocal(from, to);
    expect(fs.existsSync(to)).toBe(true);
    expect(fs.existsSync(from)).toBe(false);

    await ctrl.removeLocal(to);
    expect(fs.existsSync(to)).toBe(false);
  });

  it("删除不存在的路径会 reject", async () => {
    await expect(ctrl.removeLocal(path.join(dir, "ghost"))).rejects.toBeTruthy();
  });
});
