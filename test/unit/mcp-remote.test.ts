/* MCP 的远端原语 + 四个只读工具 + 连接池。
   全部用假实现,不碰网络/SSH —— 真实的端到端验证放到真机那一步。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { listRemote, permString, readRemote, statRemote, type SftpLike } from "../../src/main/mcp/remote";
import { buildReadTools, capList, resolveHost, type McpToolDeps } from "../../src/main/mcp/tools";
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
  return {
    listHosts: () => hosts,
    findHost: (q) => hosts.find((h) => h.id === q || h.name === q),
    remote: {
      list: async () => [{ name: "a.txt", type: "file", size: 1, mtime: 1, mode: 0o100644, perm: "-rw-r--r--" }],
      read: async () => ({ text: "hi", truncated: false, size: 2, binary: false }),
      stat: async () => ({ name: "a.txt", type: "file", size: 2, mtime: 1, mode: 0o100644, perm: "-rw-r--r--" }),
      ...overrides,
    },
  };
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
