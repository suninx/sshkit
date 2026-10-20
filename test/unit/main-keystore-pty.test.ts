import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * keystore.ts(凭据只写不读的边界)与 pty.ts(本地终端)的行为测试。
 * 两者都依赖原生/系统能力,所以用忠实假件:keytar 用内存 Map,node-pty 用假 spawn。
 */
const store = new Map<string, string>();
vi.mock("keytar", () => ({
  default: {
    setPassword: async (svc: string, acct: string, pw: string) => { store.set(`${svc}|${acct}`, pw); },
    getPassword: async (svc: string, acct: string) => store.get(`${svc}|${acct}`) ?? null,
    deletePassword: async (svc: string, acct: string) => store.delete(`${svc}|${acct}`),
  },
}));

interface SpawnOpts { name?: string; cols: number; rows: number; cwd?: string; env?: Record<string, string> }
const spawned: Array<{ file: string; args: string[]; opts: SpawnOpts }> = [];

class FakePty {
  dataCbs: Array<(d: string) => void> = [];
  exitCbs: Array<(e: { exitCode: number }) => void> = [];
  written: string[] = [];
  resized: Array<[number, number]> = [];
  killed = 0;
  onData = (cb: (d: string) => void) => { this.dataCbs.push(cb); return { dispose: () => undefined }; };
  onExit = (cb: (e: { exitCode: number }) => void) => { this.exitCbs.push(cb); return { dispose: () => undefined }; };
  write = (d: string) => { this.written.push(d); };
  resize = (c: number, r: number) => { this.resized.push([c, r]); };
  kill = () => { this.killed++; };
  emitData(d: string) { for (const cb of this.dataCbs) cb(d); }
  emitExit(code: number) { for (const cb of this.exitCbs) cb({ exitCode: code }); }
}
let lastPty: FakePty;

vi.mock("node-pty", () => ({
  spawn: (file: string, args: string[], opts: SpawnOpts) => {
    spawned.push({ file, args, opts });
    lastPty = new FakePty();
    return lastPty;
  },
}));

const fakeSender = () => ({ send: vi.fn(), isDestroyed: () => false });

beforeEach(() => { store.clear(); spawned.length = 0; });

describe("pty:本地终端", () => {
  it("create 用 $SHELL 与给定尺寸 spawn,并带上终端环境变量", async () => {
    const { PtyService } = await import("../../src/main/pty");
    const svc = new PtyService();
    const sender = fakeSender();
    const id = svc.create(sender as never, { cols: 100, rows: 30 });

    expect(typeof id).toBe("number");
    expect(spawned).toHaveLength(1);
    expect(spawned[0].file).toBe(process.env.SHELL || "/bin/zsh");
    expect(spawned[0].args).toEqual([]);                    // 直接起交互 shell,不额外加参数
    expect(spawned[0].opts).toMatchObject({ name: "xterm-256color", cols: 100, rows: 30 });
    expect(spawned[0].opts.env).toMatchObject({ TERM: "xterm-256color", COLORTERM: "truecolor" });
    // 关键:cleanEnv 必须剥掉 ELECTRON_RUN_AS_NODE(否则 shell 里起 Electron 会退化成 Node)
    expect(spawned[0].opts.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("尺寸会被夹取到合理范围(2..500 / 2..200)", async () => {
    const { PtyService } = await import("../../src/main/pty");
    const svc = new PtyService();
    svc.create(fakeSender() as never, { cols: 9999, rows: 9999 });
    expect(spawned[0].opts).toMatchObject({ cols: 500, rows: 200 });
    svc.create(fakeSender() as never, { cols: 0, rows: 1 });
    expect(spawned[1].opts).toMatchObject({ cols: 2, rows: 2 });
  });

  it("pty 输出与退出被转发给渲染层", async () => {
    const { PtyService } = await import("../../src/main/pty");
    const svc = new PtyService();
    const sender = fakeSender();
    const id = svc.create(sender as never, { cols: 80, rows: 24 });
    lastPty.emitData("hello");
    expect(sender.send).toHaveBeenCalledWith("terminal:data", id, "hello");
    lastPty.emitExit(3);
    expect(sender.send).toHaveBeenCalledWith("terminal:exit", id, { exitCode: 3 });
  });

  it("窗口已销毁时不再往渲染层发消息(isDestroyed 守卫)", async () => {
    const { PtyService } = await import("../../src/main/pty");
    const svc = new PtyService();
    const send = vi.fn();
    svc.create({ send, isDestroyed: () => true } as never, { cols: 80, rows: 24 });
    lastPty.emitData("ignored");
    lastPty.emitExit(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("write/resize 作用到对应 pty;resize 同样夹取;未知 id 安全忽略", async () => {
    const { PtyService } = await import("../../src/main/pty");
    const svc = new PtyService();
    const id = svc.create(fakeSender() as never, { cols: 80, rows: 24 });
    svc.write(id, "ls\r");
    svc.resize(id, 120, 40);
    expect(lastPty.written).toEqual(["ls\r"]);
    expect(lastPty.resized).toEqual([[120, 40]]);
    svc.resize(id, 1, 1);
    expect(lastPty.resized.at(-1)).toEqual([2, 2]);
    expect(() => svc.write(999, "x")).not.toThrow();
    expect(() => svc.resize(999, 80, 24)).not.toThrow();
  });

  it("dispose 杀掉 pty;重复 dispose 安全;disposeAll 清理全部", async () => {
    const { PtyService } = await import("../../src/main/pty");
    const svc = new PtyService();
    const a = svc.create(fakeSender() as never, { cols: 80, rows: 24 });
    const ptyA = lastPty;
    svc.dispose(a);
    expect(ptyA.killed).toBe(1);
    expect(() => svc.dispose(a)).not.toThrow();

    svc.create(fakeSender() as never, { cols: 80, rows: 24 });
    svc.create(fakeSender() as never, { cols: 80, rows: 24 });
    svc.disposeAll();
    expect(ptyA.killed).toBe(1);
  });
});
