/* MCP 的远端原语 + 四个只读工具 + 连接池。
   全部用假实现,不碰网络/SSH —— 真实的端到端验证放到真机那一步。 */
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodRemote, downloadFiles, listRemote, mkdirRemote, permString, readRemote, removeRemote,
  renameRemote, statRemote, uploadFiles, writeRemote, type SftpLike,
} from "../../src/main/mcp/remote";
import { buildReadTools, buildWriteTools, capList, parseMode, resolveHost, type McpToolDeps } from "../../src/main/mcp/tools";
import { RemotePool } from "../../src/main/mcp/pool";

interface FakeEntry { filename: string; attrs: { mode: number; size: number; mtime: number; isDirectory?: () => boolean } }

function fakeSftp(opts: {
  entries?: Record<string, FakeEntry[]>;
  files?: Record<string, Buffer>;
  failReaddir?: string;
  failStat?: string;
  failStream?: string;
}): SftpLike {
  return {
    readdir(path, cb) {
      if (opts.failReaddir === path) { cb(new Error("permission denied"), []); return; }
      cb(null, opts.entries?.[path] ?? []);
    },
    stat(path, cb) {
      if (opts.failStat === path) { cb(new Error("no such file"), { mode: 0, size: 0, mtime: 0 }); return; }
      const f = opts.files?.[path];
      if (f) { cb(null, { mode: 0o100644, size: f.length, mtime: 1700000000 }); return; }
      cb(null, { mode: 0o040755, size: 4096, mtime: 1700000000, isDirectory: () => true });
    },
    createReadStream(path) {
      const { Readable } = require("node:stream") as typeof import("node:stream");
      if (opts.failStream === path) {
        const s = new Readable({ read() { this.destroy(new Error("io error")); } });
        return s;
      }
      const buf = opts.files?.[path] ?? Buffer.alloc(0);
      return Readable.from([buf]);
    },
  } as unknown as SftpLike;
}

describe("remote 原语", () => {
  it("permString:目录/文件/未知类型", () => {
    expect(permString(0o040755)).toBe("drwxr-xr-x");
    expect(permString(0o100600)).toBe("-rw-------");
    expect(permString(0o120777)).toBe("?rwxrwxrwx");
    expect(permString(0o100444)).toBe("-r--r--r--");
  });

  it("listRemote:目录排前面,同类型按名字;isDirectory 缺失时按 mode 判断", async () => {
    const sftp = fakeSftp({
      entries: {
        "/d": [
          { filename: "z.txt", attrs: { mode: 0o100644, size: 3, mtime: 1 } },
          { filename: "a.txt", attrs: { mode: 0o100644, size: 2, mtime: 1 } },
          { filename: "sub", attrs: { mode: 0o040755, size: 10, mtime: 1 } },
          { filename: "link", attrs: { mode: 0o120777, size: 5, mtime: 1 } },
          { filename: "dir2", attrs: { mode: 0o040755, size: 10, mtime: 1, isDirectory: () => true } },
        ],
      },
    });
    const out = await listRemote(sftp, "/d");
    expect(out.map((e) => e.name)).toEqual(["dir2", "sub", "a.txt", "z.txt", "link"]);
    expect(out[0]).toMatchObject({ type: "dir", perm: "drwxr-xr-x" });
    expect(out[3]).toMatchObject({ type: "file", perm: "-rw-r--r--", size: 3 });
    expect(out[4]).toMatchObject({ type: "other", perm: "?rwxrwxrwx" });
  });

  it("mode 为 0(部分服务端不填类型位)按普通文件处理", async () => {
    const out = await listRemote(fakeSftp({ entries: { "/d": [{ filename: "n", attrs: { mode: 0, size: 1, mtime: 1 } }] } }), "/d");
    /* mode 全 0 就是没有任何权限位 —— 类型仍按"普通文件"处理 */
    expect(out[0]).toMatchObject({ type: "file", perm: "----------" });
  });

  it("listRemote/statRemote 的错误会抛出来", async () => {
    await expect(listRemote(fakeSftp({ failReaddir: "/x" }), "/x")).rejects.toThrow("permission denied");
    await expect(statRemote(fakeSftp({ failStat: "/y" }), "/y")).rejects.toThrow("no such file");
  });

  it("statRemote:名字取最后一段,尾部斜杠也能处理(根目录回退成 /)", async () => {
    const sftp = fakeSftp({ files: { "/a/b.txt": Buffer.from("hello") } });
    expect((await statRemote(sftp, "/a/b.txt")).name).toBe("b.txt");
    expect((await statRemote(sftp, "/")).name).toBe("/");
    expect((await statRemote(sftp, "/a/dir/")).name).toBe("dir");
  });

  it("readRemote:文本/截断/二进制/流错误", async () => {
    const content = Buffer.from("#!/bin/sh\necho hi\n");
    const sftp = fakeSftp({ files: { "/s.sh": content } });
    const full = await readRemote(sftp, "/s.sh", 1024);
    expect(full).toMatchObject({ text: content.toString("utf-8"), truncated: false, size: content.length, binary: false });
    /* 读取上限比文件小:内容按上限截,但 truncated 用真实 size 判断 */
    const part = await readRemote(sftp, "/s.sh", 4);
    expect(part.truncated).toBe(true);
    expect(part.size).toBe(content.length);

    const bin = fakeSftp({ files: { "/x.bin": Buffer.from([1, 0, 2]) } });
    expect((await readRemote(bin, "/x.bin", 16)).binary).toBe(true);

    await expect(readRemote(fakeSftp({ failStat: "/nope" }), "/nope", 16)).rejects.toThrow("no such file");
    await expect(readRemote(fakeSftp({ failStream: "/boom" }), "/boom", 16)).rejects.toThrow("io error");
  });
});

const HOSTS = [
  { id: "h1", name: "prod", host: "10.0.0.1", port: 22, username: "root", authType: "password" },
  { id: "h2", name: "staging", host: "10.0.0.2", port: 22, username: "deploy", authType: "key" },
];

function deps(overrides: Partial<McpToolDeps["remote"]> = {}, hosts = HOSTS): McpToolDeps {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    listHosts: () => hosts,
    findHost: (q) => hosts.find((h) => h.id === q || h.name === q),
    remote: {
      mkdir: async (...a) => { calls.push(["mkdir", ...a]); },
      rename: async (...a) => { calls.push(["rename", ...a]); },
      remove: async (...a) => { calls.push(["remove", ...a]); },
      chmod: async (...a) => { calls.push(["chmod", ...a]); },
      write: async (...a) => { calls.push(["write", ...a]); return 3; },
      upload: async (...a) => { calls.push(["upload", ...a]); return { bytes: 7 }; },
      download: async (...a) => { calls.push(["download", ...a]); return { bytes: 9 }; },
      list: async () => [{ name: "a.txt", type: "file", size: 1, mtime: 1, mode: 0o100644, perm: "-rw-r--r--" }],
      read: async () => ({ text: "hi", truncated: false, size: 2, binary: false }),
      stat: async () => ({ name: "a.txt", type: "file", size: 2, mtime: 1, mode: 0o100644, perm: "-rw-r--r--" }),
      ...overrides,
    },
    /* 测试里直接看这些调用记录(与 remote 同一条 deps) */
    __calls: calls,
  } as McpToolDeps & { __calls: Array<[string, ...unknown[]]> };
}

const callTool = async (toolName: string, args: Record<string, unknown>, d: McpToolDeps) => {
  const tool = buildReadTools(d).find((t) => t.def.name === toolName)!;
  return await tool.run(args, { signal: new AbortController().signal });
};

describe("MCP 只读工具", () => {
  it("list_hosts:不含任何凭据字段", async () => {
    const r = await callTool("list_hosts", {}, deps());
    const body = JSON.parse(r.text) as { hosts: Array<Record<string, unknown>>; count: number };
    expect(body.count).toBe(2);
    expect(body.hosts[0]).toMatchObject({ id: "h1", name: "prod", address: "10.0.0.1:22", username: "root" });
    /* authType 的值本来就是 "password"(认证方式),这里要排除的是凭据本身 */
    expect(r.text).not.toContain("passphrase");
    expect(r.text).not.toContain("secret");
  });

  it("sftp_list:按 id 或名字找主机;超过 500 条会截断", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ name: `f${i}`, type: "file" as const, size: i, mtime: 0, mode: 0o100644, perm: "-rw-r--r--" }));
    const d = deps({ list: async () => many });
    const r = await callTool("sftp_list", { host: "h2", path: "/data" }, d);
    const body = JSON.parse(r.text) as { count: number; truncated: boolean; entries: unknown[]; truncatedAt: number | null };
    expect(body).toMatchObject({ count: 501, truncated: true });
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.length).toBeLessThanOrEqual(500);
    expect(body.truncatedAt).toBe(body.entries.length);
    const byName = await callTool("sftp_list", { host: "prod", path: "/data" }, deps());
    expect(byName.text).toContain('"path": "/data"');
  });

  it("sftp_read_file:默认上限/上限夹取/截断提示/二进制报错", async () => {
    const seen: number[] = [];
    const d = deps({ read: async (_h, _f, maxBytes) => { seen.push(maxBytes); return { text: "ok", truncated: true, size: 999, binary: false }; } });
    await callTool("sftp_read_file", { host: "h1", path: "/x" }, d);
    await callTool("sftp_read_file", { host: "h1", path: "/x", maxBytes: 9_999_999 }, d);
    await callTool("sftp_read_file", { host: "h1", path: "/x", maxBytes: 0.4 }, d);
    expect(seen).toEqual([131072, 131072, 1]);
    const r = await callTool("sftp_read_file", { host: "h1", path: "/x" }, d);
    expect(r.text).toContain("first 131072 shown");

    const binDeps = deps({ read: async () => ({ text: "", truncated: false, size: 10, binary: true }) });
    const bin = await callTool("sftp_read_file", { host: "h1", path: "/x.bin" }, binDeps);
    expect(bin.isError).toBe(true);
    expect(bin.text).toContain("[binary file]");
  });

  it("capList:放不下就少放几条,始终保持合法 JSON", () => {
    const items = Array.from({ length: 3000 }, (_, i) => ({ name: `file-${i}`, size: i, perm: "-rw-r--r--" }));
    const tiny = JSON.parse(capList({ path: "/big" }, "entries", items)) as { entries: unknown[]; truncatedAt: number | null };
    expect(tiny.entries.length).toBeGreaterThan(0);
    expect(tiny.entries.length).toBeLessThan(3000);
    expect(tiny.truncatedAt).toBe(tiny.entries.length);
    const all = JSON.parse(capList({ path: "/small" }, "entries", items.slice(0, 2))) as { entries: unknown[]; truncatedAt: number | null };
    expect(all).toMatchObject({ truncatedAt: null });
    expect(all.entries.length).toBe(2);
  });

  it("sftp_read_file 未截断时不加 'first N shown' 提示;超长文本走 clipOut", async () => {
    const r = await callTool("sftp_read_file", { host: "h1", path: "/x" }, deps());
    expect(r.text).not.toContain("first");
    const huge = "x".repeat(30_000);
    const big = await callTool("sftp_read_file", { host: "h1", path: "/x" },
      deps({ read: async () => ({ text: huge, truncated: false, size: huge.length, binary: false }) }));
    expect(big.text).toContain("输出被截断");
  });

  it("sftp_stat:返回 mode/perm", async () => {
    const r = await callTool("sftp_stat", { host: "h1", path: "/x" }, deps());
    expect(JSON.parse(r.text)).toMatchObject({ path: "/x", perm: "-rw-r--r--", mode: 0o100644 });
  });

  it("主机找不到:错误信息里列出可用主机;一台都没有时给出 (none)", async () => {
    expect(() => resolveHost(deps(), "nope")).toThrow(/Available hosts: h1 \(prod\), h2 \(staging\)/);
    expect(() => resolveHost(deps({}, []), "nope")).toThrow(/\(none\)/);
    await expect(callTool("sftp_list", { host: "nope", path: "/" }, deps())).rejects.toThrow("unknown host");
  });

  it("必填参数缺失/空白会报清楚", async () => {
    await expect(callTool("sftp_list", { host: "h1" }, deps())).rejects.toThrow('parameter "path"');
    await expect(callTool("sftp_list", { host: "  ", path: "/" }, deps())).rejects.toThrow('parameter "host"');
    await expect(callTool("sftp_stat", { host: "h1", path: 42 as unknown as string }, deps())).rejects.toThrow('parameter "path"');
  });

  it("工具定义是 IDEA 那种风格:有 title/description/kind/JSON Schema", () => {
    const tools = buildReadTools(deps());
    expect(tools.map((t) => t.def.name)).toEqual(["list_hosts", "sftp_list", "sftp_read_file", "sftp_stat"]);
    for (const t of tools) {
      expect(t.def.title.length).toBeGreaterThan(0);
      expect(t.def.description.length).toBeGreaterThan(20);
      expect(t.def.kind).toBe("read");
      expect(t.def.inputSchema).toHaveProperty("type", "object");
    }
  });
});

describe("remote 写入 / 传输", () => {
  const ok = (fn: () => void) => (cb?: (e?: Error | null) => void) => { fn(); cb?.(null); };

  it("mkdir / rename / chmod / unlink / rmdir 都真的调用到对应方法", async () => {
    const calls: string[] = [];
    const files = new Map<string, { mode: number }>();
    const sftp = {
      stat: (p: string, cb: (e: Error | null, attrs: { mode: number; size: number; mtime: number }) => void) => {
        const f = files.get(p);
        if (!f) { cb(Object.assign(new Error("no such file"), { code: 2 }), undefined as never); return; }
        cb(null, { mode: f.mode, size: 0, mtime: 0 });
      },
      mkdir: (p: string, cb: (e?: Error | null) => void) => { calls.push(`mkdir:${p}`); cb(null); },
      rename: (a: string, b: string, cb: (e?: Error | null) => void) => { calls.push(`rename:${a}->${b}`); cb(null); },
      chmod: (p: string, m: number, cb: (e?: Error | null) => void) => { calls.push(`chmod:${p}:${m.toString(8)}`); cb(null); },
      unlink: (p: string, cb: (e?: Error | null) => void) => { calls.push(`unlink:${p}`); cb(null); },
      rmdir: (p: string, cb: (e?: Error | null) => void) => { calls.push(`rmdir:${p}`); cb(null); },
    } as unknown as SftpLike;
    await mkdirRemote(sftp, "/d");
    await renameRemote(sftp, "/a", "/b");
    await chmodRemote(sftp, "/a", 0o600);
    files.set("/f", { mode: 0o100644 });
    files.set("/d2", { mode: 0o040755 });
    await removeRemote(sftp, "/f");
    await removeRemote(sftp, "/d2");
    expect(calls).toEqual(["mkdir:/d", "rename:/a->/b", "chmod:/a:600", "unlink:/f", "rmdir:/d2"]);
  });

  it("remove 优先用 isDirectory();目录缺 rmdir / 文件缺 unlink 时报清楚", async () => {
    const calls: string[] = [];
    const withDir = {
      stat: (_p: string, cb: (e: Error | null, a: { mode: number; size: number; mtime: number; isDirectory: () => boolean }) => void) =>
        cb(null, { mode: 0, size: 0, mtime: 0, isDirectory: () => true }),
      rmdir: (p: string, cb: (e?: Error | null) => void) => { calls.push(`rmdir:${p}`); cb(null); },
    } as unknown as SftpLike;
    await removeRemote(withDir, "/dir");
    expect(calls).toEqual(["rmdir:/dir"]);
    const noRmdir = { stat: (_p: string, cb: (e: Error | null, a: never) => void) => cb(null, { mode: 0o040755 } as never) } as unknown as SftpLike;
    await expect(removeRemote(noRmdir, "/dir")).rejects.toThrow("does not support rmdir");
    const noUnlink = { stat: (_p: string, cb: (e: Error | null, a: never) => void) => cb(null, { mode: 0o100644 } as never) } as unknown as SftpLike;
    await expect(removeRemote(noUnlink, "/f")).rejects.toThrow("does not support unlink");
    const unlinkFails = {
      stat: (_p: string, cb: (e: Error | null, a: never) => void) => cb(null, { mode: 0o100644 } as never),
      unlink: (_p: string, cb: (e?: Error | null) => void) => cb(new Error("busy")),
    } as unknown as SftpLike;
    await expect(removeRemote(unlinkFails, "/f")).rejects.toThrow("busy");
  });

  it("mkdir/rename/chmod 的底层错误原样抛出", async () => {
    const fail = (cb: (e?: Error | null) => void) => cb(new Error("perm denied"));
    const sftp = {
      mkdir: (_p: string, cb: (e?: Error | null) => void) => fail(cb),
      rename: (_a: string, _b: string, cb: (e?: Error | null) => void) => fail(cb),
      chmod: (_p: string, _m: number, cb: (e?: Error | null) => void) => fail(cb),
    } as unknown as SftpLike;
    await expect(mkdirRemote(sftp, "/d")).rejects.toThrow("perm denied");
    await expect(renameRemote(sftp, "/a", "/b")).rejects.toThrow("perm denied");
    await expect(chmodRemote(sftp, "/a", 0o600)).rejects.toThrow("perm denied");
  });

  it("删除不存在的路径会抛错;服务端缺方法时给出明确错误", async () => {
    const sftp = { stat: (_p: string, cb: (e: Error | null, a: never) => void) => cb(Object.assign(new Error("no such file"), {}), undefined as never) } as unknown as SftpLike;
    await expect(removeRemote(sftp, "/nope")).rejects.toThrow("no such file");
    await expect(mkdirRemote({} as SftpLike, "/d")).rejects.toThrow("does not support mkdir");
    await expect(renameRemote({} as SftpLike, "/a", "/b")).rejects.toThrow("does not support rename");
    await expect(chmodRemote({} as SftpLike, "/a", 0o600)).rejects.toThrow("does not support chmod");
    await expect(writeRemote({} as SftpLike, "/f", Buffer.from("x"))).rejects.toThrow("does not support createWriteStream");
    await expect(uploadFiles({} as SftpLike, () => Readable.from([Buffer.from("x")]), "/f")).rejects.toThrow("does not support createWriteStream");
  });

  it("writeRemote 覆盖写入并按 finish 结算;写入流报错会 reject", async () => {
    const writes: Buffer[] = [];
    const sftp = {
      createWriteStream: () => {
        const ws = new Writable({ write(c: Buffer, _e, cb) { writes.push(Buffer.from(c)); cb(); } });
        return ws;
      },
    } as unknown as SftpLike;
    expect(await writeRemote(sftp, "/f", Buffer.from("hello"))).toBe(5);
    expect(Buffer.concat(writes).toString()).toBe("hello");

    const bad = { createWriteStream: () => { const ws = new Writable({ write(_c, _e, cb) { cb(new Error("disk full")); } }); return ws; } } as unknown as SftpLike;
    await expect(writeRemote(bad, "/f", Buffer.from("x"))).rejects.toThrow("disk full");
  });

  it("upload/download 流式传输并回报字节数;读流/写流出错会 reject", async () => {
    const store = new Map<string, Buffer>();
    const sftp = {
      createWriteStream: (p: string) => new Writable({ write(c: Buffer, _e, cb) { store.set(p, Buffer.concat([store.get(p) ?? Buffer.alloc(0), Buffer.from(c)])); cb(); } }),
      createReadStream: (p: string) => Readable.from([store.get(p) ?? Buffer.alloc(0)]),
    } as unknown as SftpLike;

    const progress: number[] = [];
    const up = await uploadFiles(sftp, () => Readable.from([Buffer.from("abc"), Buffer.from("de")]), "/r", (n) => progress.push(n));
    expect(up.bytes).toBe(5);
    expect(progress).toEqual([3, 5]);
    const down = await downloadFiles(sftp, "/r", () => new Writable({ write(_c, _e, cb) { cb(); } }));
    expect(down.bytes).toBe(5);

    const badRead = { createReadStream: () => { const r = new Readable({ read() { this.destroy(new Error("read boom")); } }); return r; } } as unknown as SftpLike;
    await expect(downloadFiles(badRead, "/r", () => new Writable({ write(_c, _e, cb) { cb(); } }))).rejects.toThrow("read boom");
    const badWrite = { createWriteStream: () => { const ws = new Writable({ write(_c, _e, cb) { cb(new Error("write boom")); } }); return ws; } } as unknown as SftpLike;
    await expect(uploadFiles(badWrite, () => Readable.from([Buffer.from("x")]), "/r")).rejects.toThrow("write boom");
  });
});

describe("RemotePool", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("同一主机只开一条连接;drop/closeAll 会关掉", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const pool = new RemotePool(async (id) => { opened.push(id); return { sftp: fakeSftp({}), close: () => closed.push(id) }; });
    const a = await pool.get("h1");
    const b = await pool.get("h1");
    expect(a).toBe(b);
    expect(opened).toEqual(["h1"]);
    expect(pool.size).toBe(1);
    pool.drop("h1");
    expect(closed).toEqual(["h1"]);
    pool.drop("unknown");           // 不存在时是 no-op
    await pool.get("h2");
    pool.closeAll();
    expect(closed).toContain("h2");
    expect(pool.size).toBe(0);
  });

  it("闲置到期自动关连接", async () => {
    vi.useFakeTimers();
    const closed: string[] = [];
    const pool = new RemotePool(async (id) => ({ sftp: fakeSftp({}), close: () => closed.push(id) }), 1_000);
    await pool.get("h1");
    await vi.advanceTimersByTimeAsync(999);
    expect(closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toEqual(["h1"]);
    expect(pool.size).toBe(0);
  });

  it("再次访问会重置空闲计时", async () => {
    vi.useFakeTimers();
    const closed: string[] = [];
    const pool = new RemotePool(async (id) => ({ sftp: fakeSftp({}), close: () => closed.push(id) }), 1_000);
    await pool.get("h1");
    await vi.advanceTimersByTimeAsync(800);
    await pool.get("h1");
    await vi.advanceTimersByTimeAsync(800);
    expect(closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(closed).toEqual(["h1"]);
  });
});

describe("MCP 写工具(阶段 2)", () => {
  const callWrite = async (name: string, args: Record<string, unknown>, d: McpToolDeps & { __calls: Array<[string, ...unknown[]]> }) => {
    const tool = buildWriteTools(d).find((t) => t.def.name === name)!;
    return await tool.run(args, { signal: new AbortController().signal });
  };

  it("七个写工具都会真的调用远端,并返回可读结果", async () => {
    const d = deps();
    expect((await callWrite("sftp_mkdir", { host: "prod", path: "/d" }, d)).text).toContain("created directory");
    expect((await callWrite("sftp_rename", { host: "h1", from: "/a", to: "/b" }, d)).text).toContain("renamed");
    expect((await callWrite("sftp_remove", { host: "h1", path: "/a" }, d)).text).toContain("removed");
    expect((await callWrite("sftp_chmod", { host: "h2", path: "/a", mode: "600" }, d)).text).toBe("chmod 600 staging:/a");
    expect((await callWrite("sftp_write_file", { host: "h1", path: "/f", content: "hi" }, d)).text).toContain("wrote 3 bytes");
    expect((await callWrite("sftp_upload", { host: "h1", localPath: "/tmp/x", remotePath: "/r/x" }, d)).text).toContain("uploaded 7 bytes");
    expect((await callWrite("sftp_download", { host: "h1", remotePath: "/r/x", localPath: "/tmp/x" }, d)).text).toContain("downloaded 9 bytes");
    /* 参数确实按 (hostId, ...) 传给远端层 */
    expect(d.__calls.slice(0, 3)).toEqual([
      ["mkdir", "h1", "/d"], ["rename", "h1", "/a", "/b"], ["remove", "h1", "/a"],
    ]);
    expect(d.__calls.at(-1)).toEqual(["download", "h1", "/r/x", "/tmp/x"]);
  });

  it("写入类操作把底层错误原样抛出(不吞错)", async () => {
    const boom = new Error("permission denied");
    const d = deps({
      mkdir: async () => { throw boom; },
      rename: async () => { throw boom; },
      chmod: async () => { throw boom; },
      write: async () => { throw boom; },
      upload: async () => { throw boom; },
      download: async () => { throw boom; },
    });
    await expect(callWrite("sftp_mkdir", { host: "h1", path: "/d" }, d)).rejects.toThrow("permission denied");
    await expect(callWrite("sftp_rename", { host: "h1", from: "/a", to: "/b" }, d)).rejects.toThrow("permission denied");
    await expect(callWrite("sftp_chmod", { host: "h1", path: "/a", mode: "600" }, d)).rejects.toThrow("permission denied");
    await expect(callWrite("sftp_write_file", { host: "h1", path: "/f", content: "x" }, d)).rejects.toThrow("permission denied");
    await expect(callWrite("sftp_upload", { host: "h1", localPath: "/l", remotePath: "/r" }, d)).rejects.toThrow("permission denied");
    await expect(callWrite("sftp_download", { host: "h1", remotePath: "/r", localPath: "/l" }, d)).rejects.toThrow("permission denied");
  });

  it("权限串解析:合法八进制,非法值报错", () => {
    expect(parseMode("644")).toBe(0o644);
    expect(parseMode("0755")).toBe(0o755);
    expect(parseMode(" 4777 ")).toBe(0o4777);
    for (const bad of ["abc", "888", "64", "0o644", ""]) {
      expect(() => parseMode(bad)).toThrow(/invalid permission mode/);
    }
  });

  it("写工具的必填参数与 content 类型都会校验", async () => {
    const d = deps();
    await expect(callWrite("sftp_mkdir", { host: "h1" }, d)).rejects.toThrow('parameter "path"');
    await expect(callWrite("sftp_rename", { host: "h1", from: "/a" }, d)).rejects.toThrow('parameter "to"');
    await expect(callWrite("sftp_write_file", { host: "h1", path: "/f", content: 42 }, d)).rejects.toThrow('parameter "content"');
    await expect(callWrite("sftp_write_file", { host: "missing", path: "/f", content: "x" }, d)).rejects.toThrow(/unknown host/);
  });

  it("写工具定义是 write 档(客户端能据此判断风险)", () => {
    const tools = buildWriteTools(deps());
    expect(tools.map((t) => t.def.name)).toEqual([
      "sftp_mkdir", "sftp_rename", "sftp_remove", "sftp_chmod",
      "sftp_write_file", "sftp_upload", "sftp_download",
    ]);
    for (const t of tools) expect(t.def.kind).toBe("write");
  });
});
