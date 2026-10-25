import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectVault, decryptVault, encryptVault, restoreVault, VAULT_MIN_PASSPHRASE, writeImportedKey,
} from "../../src/main/vault";
import type { HostRecord } from "../../src/shared/host";

const HOST: HostRecord = {
  id: "h_1", name: "web", host: "10.0.0.1", port: 22, username: "root",
  authType: "password", createdAt: "2026-01-01T00:00:00.000Z",
};
const payload = {
  format: "sshkit-vault" as const, version: 1, exportedAt: "2026-01-01T00:00:00.000Z",
  hosts: [{ name: "web", host: "10.0.0.1", port: 22, username: "root", authType: "password" as const, secret: { password: "p@ss" } }],
};

describe("加密备份格式", () => {
  it("往返一致:明文 → 密文 → 明文", () => {
    const text = encryptVault(payload, "correct horse battery");
    expect(text).toContain('"format": "sshkit-vault"');
    expect(text).not.toContain("p@ss");            // 密码不能明文出现
    expect(decryptVault(text, "correct horse battery")).toEqual(payload);
  });

  it("密码错 → 明确报错;文件被篡改 → 同样报错", () => {
    const text = encryptVault(payload, "correct horse battery");
    expect(() => decryptVault(text, "wrong-password")).toThrow(/invalid passphrase or corrupted/);
    const env = JSON.parse(text) as { cipher: { data: string } };
    const raw = Buffer.from(env.cipher.data, "base64");
    raw[0] ^= 0xff;
    env.cipher.data = raw.toString("base64");
    expect(() => decryptVault(JSON.stringify(env), "correct horse battery")).toThrow(/invalid passphrase/);
  });

  it("明文结构不对(合法信封但内容坏)也拒绝;私钥重名自动加后缀", () => {
    const env = JSON.parse(encryptVault(payload, "correct horse battery")) as Record<string, unknown>;
    const { cipher } = env as { cipher: { name: string } };
    /* 用正确密钥但内容不是 vault 结构:直接把 payload 换成 {} 再加密 */
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const salt = Buffer.from((env.kdf as { salt: string }).salt, "base64");
    const kdf = env.kdf as { N: number; r: number; p: number; keylen: number };
    const key = crypto.scryptSync("correct horse battery", salt, kdf.keylen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * 1024 * 1024 });
    const iv = Buffer.from((env.cipher as { iv: string }).iv, "base64");
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([c.update(JSON.stringify({ format: "sshkit-vault", hosts: "nope" }), "utf8"), c.final()]);
    (env.cipher as { data: string; tag: string }).data = data.toString("base64");
    (env.cipher as { tag: string }).tag = c.getAuthTag().toString("base64");
    expect(() => decryptVault(JSON.stringify(env), "correct horse battery")).toThrow(/malformed/);
  });

  it("非备份文件 / 版本不符 / 密码太短 都拒绝", () => {
    expect(() => decryptVault("{not json", "whatever-password")).toThrow(/not a valid/);
    expect(() => decryptVault("{}", "whatever-password")).toThrow(/not a valid/);
    expect(() => decryptVault(JSON.stringify({ format: "other" }), "whatever-password")).toThrow(/not a valid/);
    expect(() => encryptVault(payload, "short")).toThrow(new RegExp(String(VAULT_MIN_PASSPHRASE)));
  });
});

describe("收集 / 恢复", () => {
  it("收集:凭据进 secret,私钥文件内容随包", async () => {
    const keyHost: HostRecord = { ...HOST, id: "h_2", name: "keyhost", authType: "key", keyPath: "/tmp/does-not-matter" };
    const got = await collectVault({
      hosts: [HOST, keyHost],
      getSecrets: async (id) => (id === "h_1" ? { password: "p@ss" } : { passphrase: "pp" }),
      readFile: () => "-----BEGIN KEY-----",
      exists: () => true,
    });
    expect(got.hosts[0].secret).toEqual({ password: "p@ss", passphrase: undefined });
    expect(got.hosts[1].privateKeyPem).toBe("-----BEGIN KEY-----");
    expect(got.hosts[1].keyFileName).toBe("does-not-matter");
    /* 私钥文件不存在时不带内容,但记录仍在 */
    const noKey = await collectVault({ hosts: [keyHost], getSecrets: async () => ({}), readFile: () => "", exists: () => false });
    expect(noKey.hosts[0].privateKeyPem).toBeUndefined();
    /* 没有任何凭据的主机不带 secret 字段 */
    const noSecret = await collectVault({ hosts: [HOST], getSecrets: async () => ({}), readFile: () => "", exists: () => false });
    expect(noSecret.hosts[0].secret).toBeUndefined();
  });

  it("恢复:新建主机并写回凭据/私钥;重复主机跳过", async () => {
    const created: Array<{ id: string; input: Record<string, unknown> }> = [];
    const secrets: Array<[string, unknown]> = [];
    const keys: Array<[string, string]> = [];
    const existing: HostRecord[] = [{ ...HOST }];
    const res = await restoreVault({
      format: "sshkit-vault", version: 1, exportedAt: "",
      hosts: [
        /* 与现有主机完全相同 → 跳过 */
        { name: "web", host: "10.0.0.1", port: 22, username: "root", authType: "password" },
        /* 新主机,带密码 */
        { name: "db", host: "10.0.0.2", port: 22, username: "dba", authType: "password", secret: { password: "x" } },
        /* 新主机,带私钥 */
        {
          name: "key", host: "10.0.0.3", port: 2200, username: "u", authType: "key",
          keyPath: "~/old/id_ed25519", privateKeyPem: "PEM", keyFileName: "id_ed25519",
        },
        /* 新主机,无任何凭据 */
        { name: "bare", host: "10.0.0.4", port: 22, username: "b", authType: "agent" },
      ],
    }, {
      hosts: existing,
      createHost: (input) => {
        const rec = { ...input, id: `h_new${created.length}`, createdAt: "" } as HostRecord;
        created.push({ id: rec.id, input: input as unknown as Record<string, unknown> });
        existing.push(rec);
        return rec;
      },
      putSecrets: async (id, s) => { secrets.push([id, s]); },
      writeKey: (name, pem) => { keys.push([name, pem]); return `/home/u/.ssh/sshkit-imported/${name}`; },
    });
    expect(res).toEqual({ added: 3, skipped: 1 });
    expect(created.map((c) => c.input.name)).toEqual(["db", "key", "bare"]);
    expect(keys).toEqual([["id_ed25519", "PEM"]]);
    expect(created[1].input.keyPath).toBe("/home/u/.ssh/sshkit-imported/id_ed25519");
    expect(secrets).toEqual([["h_new0", { password: "x", passphrase: undefined }]]);
  });

});

describe("导入私钥落盘", () => {
  it("写到 $HOME/.ssh/sshkit-imported,重名自动加后缀,权限 0600", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-home-"));
    process.env.HOME = home;
    /* Windows 的 os.homedir() 读 USERPROFILE,不读 HOME */
    process.env.USERPROFILE = home;
    try {
      const a = writeImportedKey("id_ed25519", "A");
      expect(a).toBe(path.join(home, ".ssh", "sshkit-imported", "id_ed25519"));
      expect(fs.readFileSync(a, "utf8")).toBe("A");
      const b = writeImportedKey("id_ed25519", "B");
      expect(fs.existsSync(b)).toBe(true);
      expect(b).not.toBe(a);
      if (process.platform !== "win32") {
        expect(fs.statSync(a).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(a)).mode & 0o777).toBe(0o700);
      }
    } finally {
      process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
