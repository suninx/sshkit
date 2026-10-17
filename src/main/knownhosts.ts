import { createHash, createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * OpenSSH-compatible known_hosts pinning.
 * - Reads ~/.ssh/known_hosts (plain lines and |1| hashed entries).
 * - TOFU: first-seen host key is appended; changed key = hard refuse.
 * Written in OpenSSH format so ssh/scp on the same machine share trust.
 */
const KNOWN_HOSTS = path.join(os.homedir(), ".ssh", "known_hosts");

interface Entry {
  rawHostField: string;
  hashed?: { salt: string; digest: string };
  keyType: string;
  keyBytes: Buffer;
}

function loadEntries(file = KNOWN_HOSTS): Entry[] {
  const out: Entry[] = [];
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(" ");
    if (parts.length < 3) continue;
    let hostField = parts[0];
    const hashed = hostField.startsWith("|1|")
      ? (() => { const f = hostField.split("|"); return { salt: f[2], digest: f[3] }; })()
      : undefined;
    if (hashed) hostField = "|1|";
    try {
      out.push({ rawHostField: hostField, hashed, keyType: parts[1], keyBytes: Buffer.from(parts[2], "base64") });
    } catch { continue; }
  }
  return out;
}

function hostMatches(e: Entry, host: string): boolean {
  if (e.hashed) {
    const digest = createHmac("sha1", Buffer.from(e.hashed.salt, "base64")).update(host).digest("base64");
    return digest === e.hashed.digest;
  }
  return e.rawHostField === host || e.rawHostField.split(",").includes(host);
}

export interface HostKeyVerdict {
  status: "ok" | "learned" | "mismatch";
  message?: string;
}

/** T6:把"验"与"记"拆开 —— 未知/变更时先问用户,再由用户决定是否落盘 */
export interface HostKeyInfo {
  host: string;
  keyType: string;
  fingerprint: string;
  status: "ok" | "unknown" | "changed";
}

export interface KnownHostRow {
  host: string;
  keyType: string;
  fingerprint: string;
  /** OpenSSH 哈希化条目无法反显主机名 */
  hashed: boolean;
}

const fpOf = (keys: Buffer): string => fingerprint(keys);

/** OpenSSH 约定:22 端口写裸主机名,其它端口写 `[host]:port` */
export function knownHostField(host: string, port = 22): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

export function checkHostKey(host: string, keyData: Buffer, file = KNOWN_HOSTS): HostKeyInfo {
  const keyType = keyTypeFromBlob(keyData);
  const fp = fpOf(keyData);
  const matching = loadEntries(file).filter((e) => hostMatches(e, host));
  if (!matching.length) return { host, keyType, fingerprint: fp, status: "unknown" };
  if (matching.some((e) => e.keyType === keyType && e.keyBytes.equals(keyData))) {
    return { host, keyType, fingerprint: fp, status: "ok" };
  }
  return { host, keyType, fingerprint: fp, status: "changed" };
}

/** 写入已知主机;replace=true 时先剔除该主机的旧条目(对应原版 Replace) */
export function addHostKey(host: string, keyData: Buffer, file = KNOWN_HOSTS, replace = false): void {
  const keyType = keyTypeFromBlob(keyData);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    if (replace) removeKnownHost(host, file);
    // 追加前确保文件以换行结尾(防御:任何外部工具写出的"无尾换行"文件都不会被我们拼坏)
    try {
      const cur = readFileSync(file, "utf8");
      if (cur.length && !cur.endsWith("\n")) appendFileSync(file, "\n");
    } catch { /* 文件不存在则无需处理 */ }
    if (process.env.SSHKIT_BENCH) console.log("[bench] addHostKey →", file, "replace=", replace, "host=", host, "blob=", keyData?.length);
    appendFileSync(file, `${host} ${keyType} ${keyData.toString("base64")}\n`);
    if (process.env.SSHKIT_BENCH) console.log("[bench] addHostKey 写后行数:", readFileSync(file, "utf8").split("\n").filter((l) => l.includes(host)).length);
  } catch (err) {
    /* 只读家目录等:连接照常,只是没写盘。
       但**必须留下痕迹** —— 这里静默吞掉过一次真 bug(replace 分支删了旧条目却没写新条目),
       排查时只能靠猜。bench 模式下打印出来。 */
    if (process.env.SSHKIT_BENCH) console.error("[knownhosts] addHostKey 失败:", err);
  }
}

export function listKnownHosts(file = KNOWN_HOSTS): KnownHostRow[] {
  return loadEntries(file).map((e) => ({
    host: e.hashed ? "|1|(hashed)" : e.rawHostField,
    keyType: e.keyType,
    fingerprint: fpOf(e.keyBytes),
    hashed: !!e.hashed,
  }));
}

/** 删除某主机的已知主机条目(重写文件;哈希化条目无法按主机名匹配,故一并保留) */
export function removeKnownHost(host: string, file = KNOWN_HOSTS): number {
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return 0; }
  const keep: string[] = [];
  let removed = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { if (trimmed) keep.push(line); continue; }
    const field = trimmed.split(" ")[0];
    const hit = field.startsWith("|1|") ? false : (field === host || field.split(",").includes(host));
    if (hit) removed++;
    else keep.push(line);
  }
  if (removed) {
    /* 关键:重写后**必须保留结尾换行**。否则紧接着的 appendFileSync 会把新条目拼到上一行末尾,
       造成"看起来写进去了、其实和别的行粘在一起"的静默损坏 —— 而且会连累同文件里其它主机
       (实测踩到:192.0.2.32 那行被拼成了 9 字段)。 */
    try { writeFileSync(file, keep.length ? keep.join("\n") + "\n" : ""); }
    catch (e) { console.error("[knownhosts] 重写 known_hosts 失败:", e); }
  }
  return removed;
}

function fingerprint(keyData: Buffer): string {
  return `SHA256:${createHash("sha256").update(keyData).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Parse the algorithm name from an OpenSSH wire-format public key blob:
 * bytes [0..3] = string length, following bytes = algorithm name.
 */
export function keyTypeFromBlob(blob: Buffer): string {
  if (blob.length > 8) {
    const len = blob.readUint32BE(0);
    if (len > 0 && len < 128) {
      const name = blob.toString("utf8", 4, 4 + len);
      if (/^[a-z0-9-]+$/i.test(name)) return name;
    }
  }
  return "ssh";
}

export function verifyAndLearn(host: string, keyData: Buffer, file = KNOWN_HOSTS): HostKeyVerdict {
  const keyType = keyTypeFromBlob(keyData);
  const matching = loadEntries(file).filter((e) => hostMatches(e, host));
  if (matching.length > 0) {
    if (matching.some((e) => e.keyType === keyType && e.keyBytes.equals(keyData))) return { status: "ok" };
    return {
      status: "mismatch",
      message:
        `HOST KEY MISMATCH for ${host}. ` +
        `known_hosts has a different key for this host — refusing to connect (possible man-in-the-middle).`,
    };
  }
  // TOFU: pin the first-seen key, sharing the file with OpenSSH
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${host} ${keyType} ${keyData.toString("base64")}\n`);
  } catch { /* read-only home etc. — connect proceeds, nothing written */ }
  return { status: "learned", message: `pinned first-use key for ${host} (${keyType}, ${fingerprint(keyData)})` };
}
