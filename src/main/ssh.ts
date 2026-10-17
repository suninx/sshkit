import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { WebContents } from "electron";
import { expandHome } from "./store";
import { verifyAndLearn } from "./knownhosts";
import type { HostRecord } from "../shared/host";
import type { HostSecrets } from "./keystore";

interface SshSession {
  client: Client;
  stream: ClientChannel | null;
  decoder: StringDecoder | null;
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
    this.sessions.set(id, { client, stream: null, decoder: null });

    const safeSend = (channel: string, ...payload: unknown[]) => {
      if (!sender.isDestroyed()) sender.send(channel, ...payload);
    };

    /* ---- known_hosts pinning via hostVerifier (see ssh2 docs: this is the
            only hook carrying the raw host-key blob) ---- */
    let sawBadKey = false;
    const cfg = this.buildConfig(host, secrets);
    cfg.hostVerifier = (key: unknown, verify: (valid: boolean) => void) => {
      const blob = Buffer.from(key as Uint8Array);
      const verdict = verifyAndLearn(host.host, blob);
      console.log("[ssh]", host.host, verdict.status);
      if (verdict.status === "mismatch") {
        sawBadKey = true;
        safeSend("terminal:exit", id, { exitCode: -1, error: verdict.message });
        verify(false); // abort handshake → 'error' event on this client
        return;
      }
      if (verdict.status === "learned") {
        safeSend("terminal:data", id, `\x1b[90m[${verdict.message}]\x1b[0m\r\n`);
      }
      verify(true);
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
