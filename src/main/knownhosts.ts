import { createHash, createHmac } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
