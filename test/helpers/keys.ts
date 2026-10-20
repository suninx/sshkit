/** 构造 OpenSSH wire-format 公钥 blob(只用于 known_hosts 解析测试)。 */
export function sshBlob(algorithm: string, payload: Buffer): Buffer {
  const name = Buffer.from(algorithm, "utf8");
  const out = Buffer.alloc(4 + name.length + 4 + payload.length);
  out.writeUInt32BE(name.length, 0);
  name.copy(out, 4);
  out.writeUInt32BE(payload.length, 4 + name.length);
  payload.copy(out, 8 + name.length);
  return out;
}

/** 32 字节的 ed25519 公钥 */
export function ed25519Blob(seed = 1): Buffer {
  const payload = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) payload[i] = (seed * 31 + i * 7) & 0xff;
  return sshBlob("ssh-ed25519", payload);
}

/** 用于构造 known_hosts 行:<host> <keytype> <b64 blob>(keytype 不能省,否则是非法行) */
export function knownHostLine(host: string, blob: Buffer, type = "ssh-ed25519"): string {
  return `${host} ${type} ${blob.toString("base64")}`;
}
