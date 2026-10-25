/** 主机簿加密备份(导出/导入)。
 *
 *  需求(用户):导出时手动输入密码,用对称加密(AES)保存;导入时同样要求输入密码。
 *
 *  格式:JSON 信封 + scrypt 派生密钥 + AES-256-GCM(带认证标签 → 密码错或被篡改都能发现)。
 *  文件里包含:主机记录(不含内部 id)、每台主机的钥匙串凭据(password / passphrase)、
 *  以及私钥认证时**私钥文件内容**(这样换台机器也能恢复,否则只备份一个路径没意义)。
 *
 *  与钥匙串的关系:导出时从系统钥匙串读出;导入时写回钥匙串,schema 与 keystore 一致。 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostRecord } from "../shared/host";
import type { HostSecrets } from "./keystore";

export const VAULT_FORMAT = "sshkit-vault";
export const VAULT_VERSION = 1;
/** 密码最短长度:导出的文件里可能有服务器密码/私钥,太短没有意义 */
export const VAULT_MIN_PASSPHRASE = 8;

export interface VaultHost {
  name: string;
  group?: string;
  tags?: string[];
  host: string;
  port: number;
  username: string;
  authType: HostRecord["authType"];
  keyPath?: string;
  /** 私钥认证时随包私钥文件内容(导出时读取 keyPath) */
  privateKeyPem?: string;
  keyFileName?: string;
  /** 钥匙串里的凭据 */
  secret?: HostSecrets;
}

export interface VaultPayload {
  format: typeof VAULT_FORMAT;
  version: number;
  exportedAt: string;
  hosts: VaultHost[];
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

export interface EncryptedVault {
  format: typeof VAULT_FORMAT;
  version: number;
  /** 密码派生参数(随文件保存,导入端照此复算) */
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number; keylen: number };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string; data: string };
}

const DEFAULT_KDF: ScryptParams = { N: 32768, r: 8, p: 1, keylen: 32 };

const b64 = (b: Buffer): string => b.toString("base64");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64");

function deriveKey(passphrase: string, salt: Buffer, kdf: ScryptParams): Buffer {
  /* maxmem 要大于 128*N*r;给到 128MB 足够 N=2^15 */
  return crypto.scryptSync(passphrase, salt, kdf.keylen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * 1024 * 1024 });
}

/** 加密整个备份 → 可直接写文件的 JSON 字符串 */
export function encryptVault(payload: VaultPayload, passphrase: string, kdf: ScryptParams = DEFAULT_KDF): string {
  if (passphrase.length < VAULT_MIN_PASSPHRASE) {
    throw new Error(`passphrase must be at least ${VAULT_MIN_PASSPHRASE} characters`);
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt, kdf);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const env: EncryptedVault = {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    kdf: { name: "scrypt", salt: b64(salt), N: kdf.N, r: kdf.r, p: kdf.p, keylen: kdf.keylen },
    cipher: { name: "aes-256-gcm", iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(data) },
  };
  return JSON.stringify(env, null, 2);
}

/** 解密备份;密码错/文件被改过/格式不符都抛明确错误 */
export function decryptVault(text: string, passphrase: string): VaultPayload {
  let env: EncryptedVault;
  try {
    env = JSON.parse(text) as EncryptedVault;
  } catch {
    throw new Error("not a valid sshkit vault file");
  }
  if (env?.format !== VAULT_FORMAT || env.version !== VAULT_VERSION || env.kdf?.name !== "scrypt" || env.cipher?.name !== "aes-256-gcm") {
    throw new Error("not a valid sshkit vault file");
  }
  const kdf: ScryptParams = { N: env.kdf.N, r: env.kdf.r, p: env.kdf.p, keylen: env.kdf.keylen };
  const key = deriveKey(passphrase, unb64(env.kdf.salt), kdf);
  let plain: Buffer;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, unb64(env.cipher.iv));
    d.setAuthTag(unb64(env.cipher.tag));
    plain = Buffer.concat([d.update(unb64(env.cipher.data)), d.final()]);
  } catch {
    /* GCM 认证失败:密码错或密文被篡改,两者对外不区分 */
    throw new Error("invalid passphrase or corrupted vault file");
  }
  const payload = JSON.parse(plain.toString("utf8")) as VaultPayload;
  if (payload?.format !== VAULT_FORMAT || !Array.isArray(payload.hosts)) {
    throw new Error("vault content is malformed");
  }
  return payload;
}

/* ---------------- 收集 / 恢复 ---------------- */

const expandHome = (p: string): string => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

export interface CollectDeps {
  hosts: HostRecord[];
  getSecrets: (hostId: string) => Promise<HostSecrets>;
  readFile: (p: string) => string;
  exists?: (p: string) => boolean;
}

/** 导出前:把主机 + 凭据 + 私钥文件内容收拢成一个 payload */
export async function collectVault(deps: CollectDeps): Promise<VaultPayload> {
  const exists = deps.exists ?? fs.existsSync;
  const hosts: VaultHost[] = [];
  for (const h of deps.hosts) {
    const v: VaultHost = {
      name: h.name, group: h.group, tags: h.tags, host: h.host, port: h.port,
      username: h.username, authType: h.authType, keyPath: h.keyPath,
    };
    const secret = await deps.getSecrets(h.id);
    if (secret.password || secret.passphrase) v.secret = { password: secret.password, passphrase: secret.passphrase };
    if (h.authType === "key" && h.keyPath) {
      const file = expandHome(h.keyPath);
      if (exists(file)) {
        v.privateKeyPem = deps.readFile(file);
        v.keyFileName = path.basename(file);
      }
    }
    hosts.push(v);
  }
  return { format: VAULT_FORMAT, version: VAULT_VERSION, exportedAt: new Date().toISOString(), hosts };
}

const sameHost = (a: Pick<VaultHost, "name" | "host" | "port" | "username">, b: HostRecord): boolean =>
  a.name === b.name && a.host === b.host && a.port === b.port && a.username === b.username;

export interface RestoreDeps {
  hosts: HostRecord[];
  createHost: (input: Omit<HostRecord, "id" | "createdAt">) => HostRecord;
  putSecrets: (hostId: string, secrets: HostSecrets) => Promise<void>;
  /** 私钥写到哪:文件名 + 内容 → 返回写好的绝对路径 */
  writeKey: (fileName: string, pem: string) => string;
}

export interface RestoreResult { added: number; skipped: number }

/** 导入私钥的落盘目录(每次按当前 HOME 计算,便于测试用临时目录) */
export function importedKeyDir(): string {
  return path.join(os.homedir(), ".ssh", "sshkit-imported");
}

/** 导入:按 name+host+port+username 去重;静默跳过已存在的 */
export async function restoreVault(payload: VaultPayload, deps: RestoreDeps): Promise<RestoreResult> {
  let added = 0;
  let skipped = 0;
  for (const v of payload.hosts) {
    if (deps.hosts.some((h) => sameHost(v, h))) { skipped += 1; continue; }
    let keyPath = v.keyPath;
    if (v.privateKeyPem && v.keyFileName) {
      keyPath = deps.writeKey(v.keyFileName, v.privateKeyPem);
    }
    const rec = deps.createHost({
      name: v.name, group: v.group, tags: v.tags, host: v.host, port: v.port,
      username: v.username, authType: v.authType, keyPath,
    });
    if (v.secret && (v.secret.password || v.secret.passphrase)) {
      await deps.putSecrets(rec.id, { password: v.secret.password, passphrase: v.secret.passphrase });
    }
    added += 1;
  }
  return { added, skipped };
}

/** 默认的私钥落盘实现:写到 ~/.ssh/sshkit-imported/,权限 0600 */
export function writeImportedKey(fileName: string, pem: string): string {
  const dir = importedKeyDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = path.basename(fileName).replace(/[^\w.-]/g, "_");
  const dest = path.join(dir, safe);
  let target = dest;
  for (let i = 1; fs.existsSync(target); i += 1) target = path.join(dir, `${safe}.${i}`);
  fs.writeFileSync(target, pem, { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch { /* Windows 上权限位无意义 */ }
  return target;
}

