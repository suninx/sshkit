import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmDir, tmpDir } from "../helpers/tmp";
import { ed25519Blob, knownHostLine } from "../helpers/keys";

/**
 * knownhosts.ts 覆盖率补齐:哈希化条目匹配、bench 观测日志、导入失败/坏行统计、
 * 重写失败不静默,以及（历史 API）verifyAndLearn 的三种结论。
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-cov-kh-home-"));
const origHome = process.env.HOME;
const origProfile = process.env.USERPROFILE;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

let kh: typeof import("../../src/main/knownhosts");
let dir: string;
let file: string;
const benchEnv = process.env.SSHKIT_BENCH;

beforeAll(async () => {
  kh = await import("../../src/main/knownhosts");
});

beforeEach(() => {
  dir = tmpDir("sshkit-cov-kh-");
  file = path.join(dir, "known_hosts");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmDir(dir);
});

afterAll(() => {
  if (benchEnv === undefined) delete process.env.SSHKIT_BENCH; else process.env.SSHKIT_BENCH = benchEnv;
  process.env.HOME = origHome;
  process.env.USERPROFILE = origProfile;
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 构造 OpenSSH |1| 哈希条目:HMAC-SHA1(host, salt) */
const hashedLine = (host: string, blob: Buffer, salt = Buffer.from("0123456789abcdef")): string => {
  const digest = createHmac("sha1", salt).update(host).digest("base64");
  return `|1|${salt.toString("base64")}|${digest} ssh-ed25519 ${blob.toString("base64")}`;
};

describe("loadEntries / keyTypeFromBlob 的解析边界", () => {
  it("少于 3 个字段的行被忽略(不参与匹配也不报错)", () => {
    fs.writeFileSync(file, ["", "# comment", "only-one-field", "two fields", knownHostLine("ok.example", ed25519Blob(1))].join("\n") + "\n");
    const rows = kh.listKnownHosts(file);
    expect(rows.map((r) => r.host)).toEqual(["ok.example"]);
  });

  it("哈希条目能按主机名匹配(hostMatches 的 hashed 分支)", () => {
    const blob = ed25519Blob(2);
    fs.writeFileSync(file, hashedLine("hashed.example", blob) + "\n");
    expect(kh.checkHostKey("hashed.example", blob, file).status).toBe("ok");
    // 别的 host 用同样 key 不能命中(哈希是按主机名算的)
    expect(kh.checkHostKey("other.example", blob, file).status).toBe("unknown");
    const rows = kh.listKnownHosts(file);
    expect(rows[0]).toMatchObject({ host: "|1|(hashed)", hashed: true });
  });

  it("哈希条目里主机名不匹配 → changed(说明出现了不同的已 pin key)", () => {
    const blob = ed25519Blob(3);
    fs.writeFileSync(file, hashedLine("hashed2.example", ed25519Blob(4)) + "\n");
    expect(kh.checkHostKey("hashed2.example", blob, file).status).toBe("changed");
  });

  it("keyTypeFromBlob:过短 / 长度字段非法(0 或 >=128)/ 非算法名 → unknown", () => {
    expect(kh.keyTypeFromBlob(Buffer.from([0, 0]))).toBe("unknown");
    const zeroLen = Buffer.alloc(16);
    zeroLen.writeUInt32BE(0, 0);
    expect(kh.keyTypeFromBlob(zeroLen)).toBe("unknown");
    const hugeLen = Buffer.alloc(16);
    hugeLen.writeUInt32BE(999, 0);
    expect(kh.keyTypeFromBlob(hugeLen)).toBe("unknown");
    const badChars = Buffer.alloc(16);
    badChars.writeUInt32BE(5, 0);
    badChars.write("a b!c", 4, "utf8");
    expect(kh.keyTypeFromBlob(badChars)).toBe("unknown");
  });
});

describe("bench 模式下的观测日志(排障用,不能变成静默)", () => {
  it("addHostKey 在 SSHKIT_BENCH=1 时打印写入与替换信息", () => {
    process.env.SSHKIT_BENCH = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    kh.addHostKey("bench.example", ed25519Blob(5), file);
    kh.addHostKey("bench.example", ed25519Blob(6), file, true);
    const lines = log.mock.calls.map((c) => c.map(String).join(" "));
    expect(lines.some((l) => l.includes("[bench] addHostKey →"))).toBe(true);
    expect(lines.some((l) => l.includes("replace="))).toBe(true);
    // 写后行数日志只应包含该主机
    expect(lines.some((l) => l.includes("写后行数"))).toBe(true);
  });

  it("addHostKey 写失败时不抛,但 bench 模式必须留痕(console.error)", () => {
    process.env.SSHKIT_BENCH = "1";
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "i am a file");
    // 父路径是文件 → mkdirSync 必失败
    expect(() => kh.addHostKey("denied.example", ed25519Blob(7), path.join(blocker, "known_hosts"))).not.toThrow();
    expect(err).toHaveBeenCalledWith("[knownhosts] addHostKey 失败:", expect.anything());
  });

  it("非 bench 模式写失败静默但同样不抛(连接照常)", () => {
    delete process.env.SSHKIT_BENCH;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const blocker = path.join(dir, "blocker2");
    fs.writeFileSync(blocker, "file");
    expect(() => kh.addHostKey("quiet.example", ed25519Blob(8), path.join(blocker, "known_hosts"))).not.toThrow();
    expect(err).not.toHaveBeenCalled();
  });
});

describe("importKnownHosts 的错误与计数", () => {
  it("源文件读不到时抛出可读错误(不是静默 0)", () => {
    expect(() => kh.importKnownHosts(path.join(dir, "missing_source"), file)).toThrow(/could not read the selected file/i);
  });

  it("坏行(字段不足 / base64 解出空)计入 skipped 且不写入", () => {
    const src = path.join(dir, "src");
    fs.writeFileSync(src, [
      "only two",
      "host type *",                     // base64 解出空 → 坏行
      "# comment line",
      "",
    ].join("\n") + "\n");
    const r = kh.importKnownHosts(src, file);
    expect(r).toEqual({ added: 0, skipped: 2 });
    expect(fs.existsSync(file)).toBe(false); // 没有任何可写行时不该创建文件
  });

  it("目标文件存在但缺结尾换行时,追加的新行不会粘到上一行(回归)", () => {
    fs.writeFileSync(file, knownHostLine("a.example", ed25519Blob(1))); // 故意没有 \n
    const src = path.join(dir, "src2");
    fs.writeFileSync(src, knownHostLine("b.example", ed25519Blob(2)) + "\n");
    expect(kh.importKnownHosts(src, file)).toEqual({ added: 1, skipped: 0 });
    for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      expect(line.trim().split(/\s+/)).toHaveLength(3);
    }
    expect(kh.checkHostKey("a.example", ed25519Blob(1), file).status).toBe("ok");
    expect(kh.checkHostKey("b.example", ed25519Blob(2), file).status).toBe("ok");
  });

  it("目标目录不存在时会自动创建并写入", () => {
    const nested = path.join(dir, "x", "y", "known_hosts");
    const src = path.join(dir, "src3");
    fs.writeFileSync(src, knownHostLine("nested.example", ed25519Blob(3)) + "\n");
    expect(kh.importKnownHosts(src, nested)).toEqual({ added: 1, skipped: 0 });
    expect(kh.checkHostKey("nested.example", ed25519Blob(3), nested).status).toBe("ok");
  });
});

describe("removeKnownHost 的保留与失败路径", () => {
  it("注释行保留、空行丢弃、只删目标主机", () => {
    fs.writeFileSync(file, "# a comment\n\n" + knownHostLine("keep.example", ed25519Blob(1)) + "\n" + knownHostLine("drop.example", ed25519Blob(2)) + "\n");
    expect(kh.removeKnownHost("drop.example", file)).toBe(1);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("# a comment");
    expect(text).toContain("keep.example");
    expect(text).not.toContain("drop.example");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("重写文件失败时打日志但返回删除数(不静默吞掉写失败)", () => {
    fs.writeFileSync(file, knownHostLine("locked.example", ed25519Blob(1)) + "\n");
    fs.chmodSync(file, 0o444);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(kh.removeKnownHost("locked.example", file)).toBe(1);
      expect(spy).toHaveBeenCalledWith("[knownhosts] 重写 known_hosts 失败:", expect.anything());
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });

  it("源文件不存在时返回 0(幂等)", () => {
    expect(kh.removeKnownHost("nobody", path.join(dir, "absent"))).toBe(0);
  });
});

describe("verifyAndLearn(历史 API)的三种结论", () => {
  it("没有记录 → learned,并写入 known_hosts", () => {
    const blob = ed25519Blob(9);
    const r = kh.verifyAndLearn("learn.example", blob, file);
    expect(r.status).toBe("learned");
    expect(r.message).toMatch(/pinned first-use key/i);
    expect(kh.checkHostKey("learn.example", blob, file).status).toBe("ok");
  });

  it("key 一致 → ok;key 不同 → mismatch 且 message 明确拒绝(防中间人)", () => {
    const blob = ed25519Blob(10);
    kh.addHostKey("known.example", blob, file);
    expect(kh.verifyAndLearn("known.example", blob, file).status).toBe("ok");

    const bad = kh.verifyAndLearn("known.example", ed25519Blob(11), file);
    expect(bad.status).toBe("mismatch");
    expect(bad.message).toMatch(/possible man-in-the-middle/i);
    // mismatch 不能偷偷改文件
    expect(kh.checkHostKey("known.example", blob, file).status).toBe("ok");
  });

  it("无法写盘时仍然是 learned(连接继续,只是没 pin 住)", () => {
    const roDir = path.join(dir, "ro");
    fs.mkdirSync(roDir);
    fs.chmodSync(roDir, 0o555);
    try {
      const r = kh.verifyAndLearn("readonly.example", ed25519Blob(12), path.join(roDir, "known_hosts"));
      expect(r.status).toBe("learned");
    } finally {
      fs.chmodSync(roDir, 0o755);
    }
  });
});
