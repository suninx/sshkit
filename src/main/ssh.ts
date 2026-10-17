import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { WebContents } from "electron";
import { expandHome } from "./store";
import { addHostKey, checkHostKey, knownHostField } from "./knownhosts";
import type { HostRecord } from "../shared/host";
import type { HostSecrets } from "./keystore";

interface SshSession {
  client: Client;
  stream: ClientChannel | null;
  decoder: StringDecoder | null;
  /** T3:端口转发需要"按主机找到可用 ssh 通道" */
  hostId?: string;
}

interface PendingHostKey {
  host: string;
  blob: Buffer;
  verify: (valid: boolean) => void;
  kind: "unknown" | "changed";
}

export class SshService {
  /** ssh ids start at 1M to never collide with local pty ids */
  private nextId = 1_000_001;
  private readonly sessions = new Map<number, SshSession>();

  async connect(
    sender: WebContents,
    host: HostRecord,
    secrets: HostSecrets,
    opts: { cols: number; rows: number },
  ): Promise<number> {
    const id = this.nextId++;
    const client = new Client();
    this.sessions.set(id, { client, stream: null, decoder: null, hostId: host.id });

    const safeSend = (channel: string, ...payload: unknown[]) => {
      if (!sender.isDestroyed()) sender.send(channel, ...payload);
    };

    /* ---- T6:known_hosts 由"静默 TOFU"改为"询问式"。
            原版话术(取自其自身代码,见 F18):
              未知主机 → 标题 "Are you sure you want to connect?" + "The authenticity of <host> can not be established."
                         + "<keyType> fingerprint is SHA256:<fp>" + "Do you want to add it to the list of known hosts?"
                         按钮 Close / Continue / Add and continue
              指纹变更 → 标题 "The fingerprint for <host> has changed" + "…potential security breach." + "New <keyType> fingerprint is SHA256:<fp>"
                         按钮 Replace / Add as new / Cancel
            ssh2 的 hostVerifier 允许异步回调,故可在此等用户答复。 ---- */
    let sawBadKey = false;
    const cfg = this.buildConfig(host, secrets);
    cfg.hostVerifier = (key: unknown, verify: (valid: boolean) => void) => {
      const blob = Buffer.from(key as Uint8Array);
      const field = knownHostField(host.host, host.port); // 非 22 端口要写成 [host]:port(OpenSSH 约定)
      const info = checkHostKey(field, blob);
      console.log("[ssh]", host.host, "hostkey:", info.status);
      if (info.status === "ok") { verify(true); return; }

      const reqId = `hk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      this.pendingHostKey.set(reqId, { host: field, blob, verify, kind: info.status });
      safeSend("knownhost:ask", {
        reqId, host: field, status: info.status, keyType: info.keyType,
        // 原版文案自带 "SHA256:" 前缀,故这里去掉重复前缀,避免显示成 "SHA256: SHA256:…"
        fingerprint: info.fingerprint.replace(/^SHA256:/, ""),
      });
      // 用户不理它也要有个头:超时按"拒绝"处理(安全默认)
      setTimeout(() => {
        const p = this.pendingHostKey.get(reqId);
        if (!p) return;
        this.pendingHostKey.delete(reqId);
        sawBadKey = true;
        safeSend("terminal:exit", id, { exitCode: -1, error: `host key not confirmed for ${host.host}` });
        verify(false);
      }, 120_000);
    };

      client.on("error", (err) => {
        this.sessions.delete(id);
        if (sawBadKey) {
          // error already delivered precisely; avoid double banner noise
          safeSend("terminal:exit", id, { exitCode: -1 });
        } else {
          safeSend("terminal:exit", id, { exitCode: -1, error: err.message });
        }
      });
      client.on("close", () => {
        this.sessions.delete(id);
        safeSend("terminal:exit", id, { exitCode: 0 });
      });

      client.on("ready", () => {
        client.shell(
          { term: "xterm-256color", cols: opts.cols, rows: opts.rows },
          (err, stream) => {
            if (err) {
              this.sessions.delete(id);
              safeSend("terminal:exit", id, { exitCode: -1, error: `shell: ${err.message}` });
              client.end();
              return;
            }
            const decoder = new StringDecoder("utf8");
            this.sessions.get(id)!.stream = stream;
            this.sessions.get(id)!.decoder = decoder;
            stream.on("data", (d: Buffer) => safeSend("terminal:data", id, decoder.write(d)));
            stream.stderr?.on("data", (d: Buffer) => safeSend("terminal:data", id, decoder.write(d)));
            stream.on("close", () => {
              this.sessions.delete(id);
              safeSend("terminal:exit", id, { exitCode: 0 });
            });
          },
        );
      });

      client.connect(cfg);
      return id;
  }

  private buildConfig(host: HostRecord, secrets: HostSecrets): ConnectConfig {
    const cfg: ConnectConfig = {
      host: host.host,
      port: host.port,
      username: host.username,
      keepaliveInterval: 15000,
      keepaliveCountMax: 5,
      readyTimeout: 15000,
    };
    switch (host.authType) {
      case "password":
        if (!secrets.password) throw new Error("no saved password for this host");
        cfg.password = secrets.password;
        break;
      case "key":
        cfg.privateKey = fs.readFileSync(expandHome(host.keyPath!));
        if (secrets.passphrase) cfg.passphrase = secrets.passphrase;
        break;
      case "agent":
        cfg.agent = process.env.SSH_AUTH_SOCK;
        break;
    }
    return cfg;
  }

  clientOf(sessionId: number): Client | undefined {
    return this.sessions.get(sessionId)?.client;
  }

  /** T6:等待用户对主机密钥答复的请求 */
  private readonly pendingHostKey = new Map<string, PendingHostKey>();

  /** 渲染层答复主机密钥询问。action: continue(仅本次) / add / replace / cancel */
  answerHostKey(reqId: string, action: "continue" | "add" | "replace" | "cancel"): boolean {
    const p = this.pendingHostKey.get(reqId);
    if (!p) return false;
    this.pendingHostKey.delete(reqId);
    if (action === "cancel") { p.verify(false); return true; }
    if (action === "add" || action === "replace") addHostKey(p.host, p.blob, undefined, action === "replace");
    p.verify(true);
    return true;
  }

  /** T3:该主机当前可用的 ssh 通道(取最新一个) */
  clientOfHost(hostId: string): Client | undefined {
    let found: Client | undefined;
    for (const [, s] of this.sessions) if (s.hostId === hostId) found = s.client;
    return found;
  }

  write(id: number, data: string): void {
    this.sessions.get(id)?.stream?.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    this.sessions.get(id)?.stream?.setWindow(Math.max(2, rows), Math.max(2, cols), 0, 0);
  }

  dispose(id: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try { s.stream?.end(); } catch { /* ignore */ }
    try { s.client.end(); } catch { /* ignore */ }
  }

  disposeAll(): void {
    for (const id of Array.from(this.sessions.keys())) this.dispose(id);
  }
}
