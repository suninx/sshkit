import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmDir, tmpDir } from "../helpers/tmp";
import { ed25519Blob, knownHostLine } from "../helpers/keys";
import {
  addHostKey, checkHostKey, importKnownHosts, keyTypeFromBlob, knownHostField,
  listKnownHosts, removeKnownHost,
} from "../../src/main/knownhosts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = tmpDir("sshkit-kh-");
  file = path.join(dir, "known_hosts");
});
afterEach(() => rmDir(dir));

describe("knownHostField()", () => {
  it("22 端口用主机名,非标准端口用 [host]:port(OpenSSH 约定)", () => {
    expect(knownHostField("example.com", 22)).toBe("example.com");
    expect(knownHostField("example.com", 2222)).toBe("[example.com]:2222");
    expect(knownHostField("10.0.0.5")).toBe("10.0.0.5");
  });
});

describe("keyTypeFromBlob()", () => {
  it("从 wire-format blob 读出算法名", () => {
    expect(keyTypeFromBlob(ed25519Blob())).toBe("ssh-ed25519");
  });
  it("垃圾数据不抛错,返回 unknown", () => {
    expect(keyTypeFromBlob(Buffer.from([0, 0]))).toBe("unknown");
  });
});

describe("checkHostKey()", () => {
  it("文件不存在 → unknown", () => {
    expect(checkHostKey("h1", ed25519Blob(1), file).status).toBe("unknown");
  });

  it("写过之后 → ok(同 key)", () => {
    addHostKey("h1", ed25519Blob(1), file);
    expect(checkHostKey("h1", ed25519Blob(1), file).status).toBe("ok");
  });

  it("同主机的不同 key → changed", () => {
    addHostKey("h1", ed25519Blob(1), file);
    expect(checkHostKey("h1", ed25519Blob(2), file).status).toBe("changed");
  });

  it("非标准端口按 [host]:port 建条目", () => {
    addHostKey(knownHostField("h1", 2222), ed25519Blob(3), file);
    expect(checkHostKey("h1", ed25519Blob(3), file).status).toBe("unknown"); // 22 端口的字段与 [h1]:2222 不是同一条目
    expect(checkHostKey(knownHostField("h1", 2222), ed25519Blob(3), file).status).toBe("ok");
  });
});

describe("addHostKey()", () => {
  it("重复添加同一个 key 不会产生重复行", () => {
    addHostKey("h1", ed25519Blob(1), file);
    addHostKey("h1", ed25519Blob(1), file);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("replace=true 时替换旧 key 而不是追加", () => {
    addHostKey("h1", ed25519Blob(1), file);
    addHostKey("h1", ed25519Blob(2), file, true);
    expect(checkHostKey("h1", ed25519Blob(2), file).status).toBe("ok");
    expect(checkHostKey("h1", ed25519Blob(1), file).status).toBe("changed");
  });

  it("追加时不会把新行黏到上一行末尾(回归:缺结尾换行导致字段粘连)", () => {
    fs.writeFileSync(file, knownHostLine("a", ed25519Blob(1)));   // 故意不带结尾换行
    addHostKey("b", ed25519Blob(2), file);
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n").filter(Boolean)) {
      expect(line.trim().split(/\s+/)).toHaveLength(3);
    }
    expect(checkHostKey("a", ed25519Blob(1), file).status).toBe("ok");
    expect(checkHostKey("b", ed25519Blob(2), file).status).toBe("ok");
  });
});

describe("listKnownHosts()", () => {
  it("列出普通条目,含类型与指纹", () => {
    addHostKey("h1", ed25519Blob(1), file);
    const rows = listKnownHosts(file);
    expect(rows).toHaveLength(1);
    expect(rows[0].host).toBe("h1");
    expect(rows[0].keyType).toBe("ssh-ed25519");
    expect(rows[0].fingerprint).toMatch(/^SHA256:/);
    expect(rows[0].hashed).toBe(false);
  });

  it("哈希化条目(|1|…)标记为 hashed,不暴露主机名", () => {
    fs.writeFileSync(file, `|1|AAAA=|BBBB= ssh-ed25519 ${ed25519Blob(9).toString("base64")}\n`);
    const rows = listKnownHosts(file);
    expect(rows[0].hashed).toBe(true);
    expect(rows[0].host).toBe("|1|(hashed)");
  });

  it("逗号分隔的多主机字段都能匹配", () => {
    fs.writeFileSync(file, knownHostLine("a.com,b.com", ed25519Blob(4)) + "\n");
    expect(checkHostKey("a.com", ed25519Blob(4), file).status).toBe("ok");
    expect(checkHostKey("b.com", ed25519Blob(4), file).status).toBe("ok");
  });
});

describe("removeKnownHost()", () => {
  it("按主机名删除并保留其它行,文件仍以换行结尾", () => {
    addHostKey("a", ed25519Blob(1), file);
    addHostKey("b", ed25519Blob(2), file);
    expect(removeKnownHost("a", file)).toBe(1);
    expect(checkHostKey("a", ed25519Blob(1), file).status).toBe("unknown");
    expect(checkHostKey("b", ed25519Blob(2), file).status).toBe("ok");
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  it("哈希化条目无法按主机名删除(保留)", () => {
    const hashed = `|1|AAAA=|BBBB= ssh-ed25519 ${ed25519Blob(9).toString("base64")}\n`;
    fs.writeFileSync(file, hashed + knownHostLine("a", ed25519Blob(1)) + "\n");
    expect(removeKnownHost("a", file)).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toContain("|1|AAAA=|BBBB=");
  });

  it("不存在的主机返回 0", () => {
    addHostKey("a", ed25519Blob(1), file);
    expect(removeKnownHost("zzz", file)).toBe(0);
  });
});

describe("importKnownHosts()", () => {
  it("导入新条目并跳过已存在的重复项", () => {
    addHostKey("a", ed25519Blob(1), file);
    const src = path.join(dir, "src_known_hosts");
    fs.writeFileSync(src, [knownHostLine("a", ed25519Blob(1)), knownHostLine("c", ed25519Blob(3))].join("\n") + "\n");
    const r = importKnownHosts(src, file);
    expect(r.added).toBe(1);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(checkHostKey("c", ed25519Blob(3), file).status).toBe("ok");
  });
});
