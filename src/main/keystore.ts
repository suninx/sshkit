import keytar from "keytar";

/**
 * OS keychain wrapper. Write-only surface for the renderer:
 * the renderer can store secrets but never read them back —
 * main process reads them only at connect time.
 */
const SERVICE = "sshkit";

export interface HostSecrets {
  password?: string;
  passphrase?: string;
}

export async function putCreds(hostId: string, secrets: HostSecrets): Promise<void> {
  const payload: HostSecrets = {};
  if (secrets.password) payload.password = String(secrets.password);
  if (secrets.passphrase) payload.passphrase = String(secrets.passphrase);
  await keytar.setPassword(SERVICE, `host:${hostId}`, JSON.stringify(payload));
}

export async function getCreds(hostId: string): Promise<HostSecrets> {
  const raw = await keytar.getPassword(SERVICE, `host:${hostId}`);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as HostSecrets;
    return { password: parsed.password, passphrase: parsed.passphrase };
  } catch (e) {
    // 钥匙串里存着东西但解析不了 —— 静默返回 {} 会让"连接时提示没有保存的密码",
    // 排查看起来像"用户没存过密码",实际是数据坏了。所以要说出来。
    console.error(`[keystore] host:${hostId} 的凭据无法解析:`, e);
    return {};
  }
}

export async function deleteCreds(hostId: string): Promise<void> {
  await keytar.deletePassword(SERVICE, `host:${hostId}`);
}
