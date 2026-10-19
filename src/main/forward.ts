import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { Client } from "ssh2";
import { tr } from "../shared/i18n";

/* T3 —— 端口转发引擎。
   规格来自原版向导实测(F17):类型 Local / Remote / Dynamic;
   Local  = 本机监听 → 经中间主机转发到 Destination address:port
   Remote = 在远端监听 → 回到本机可达的 Destination
   Dynamic = 本机起 SOCKS5 代理,按目标动态转发(即 ssh -D)
   规则按主机持久化(原版亦按主机保存),启动/停止与连接计数上报给 UI。 */

export type ForwardKind = "local" | "remote" | "dynamic";

export interface ForwardRule {
  id: string;
  hostId: string;
  kind: ForwardKind;
  /** local/dynamic:本机绑定地址(原版默认 0.0.0.0) */
  bindAddress: string;
  /** local/dynamic:本机监听端口 */
  port: number;
  /** local/remote:目的地址与端口 */
  destinationAddress: string;
  destinationPort: number;
  /** remote:远端绑定地址 */
  remoteBindAddress?: string;
  label?: string;
}

export interface ForwardStatus {
  id: string;
  state: "stopped" | "starting" | "running" | "error";
  active: number;      // 当前连接数
  total: number;       // 累计连接数
  error?: string;
  boundPort?: number;  // 实际绑定端口(端口为 0 时由系统分配)
}

/** 由主进程注入:按 hostId 找到当前可用的 ssh 通道 */
type ClientLookup = (hostId: string) => Client | undefined;
type StatusSink = (status: ForwardStatus) => void;

interface Live {
  rule: ForwardRule;
  status: ForwardStatus;
  server?: net.Server;
  /** remote 型:远端分配的端口,用于停止时 cancel */
  remotePort?: number;
  sockets: Set<net.Socket>;
}

const isSocks5 = (buf: Buffer): boolean => buf.length >= 3 && buf[0] === 0x05;

export class ForwardService {
  private live = new Map<string, Live>();
  private file: string;

  constructor(
    userDataDir: string,
    private channelFor: ClientLookup,
    private statusSink: StatusSink,
  ) {
    this.file = path.join(userDataDir, "forwards.json");
  }

  /* ---------- 规则持久化 ---------- */

  listRules(): ForwardRule[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as ForwardRule[];
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }

  private writeRules(rules: ForwardRule[]): void {
    /* 原子写:先写临时文件再 rename。直接 writeFileSync 覆盖,一旦崩在写入中途,
       用户的转发规则就被截断成半个 JSON(下次启动全丢)。这是上轮 known_hosts 那类
       "静默损坏用户数据"问题的同类隐患,一并堵掉。 */
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(rules, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error("[fwd] 规则写入失败:", e); // 不静默:规则没存下必须看得见
    }
  }

  saveRule(rule: ForwardRule): ForwardRule {
    const rules = this.listRules();
    const i = rules.findIndex((r) => r.id === rule.id);
    if (i >= 0) rules[i] = rule; else rules.push(rule);
    this.writeRules(rules);
    return rule;
  }

  deleteRule(id: string): void {
    this.stop(id);
    this.writeRules(this.listRules().filter((r) => r.id !== id));
  }

  /* ---------- 状态 ---------- */

  statusOf(id: string): ForwardStatus {
    return this.live.get(id)?.status ?? { id, state: "stopped", active: 0, total: 0 };
  }

  listStatuses(): ForwardStatus[] {
    return this.listRules().map((r) => this.statusOf(r.id));
  }

  private emit(l: Live): void {
    this.statusSink({ ...l.status });
  }

  private bump(l: Live, delta: number): void {
    l.status.active = Math.max(0, l.status.active + delta);
    if (delta > 0) l.status.total++;
    this.emit(l);
  }

  /* ---------- 起停 ---------- */

  start(rule: ForwardRule): ForwardStatus {
    if (this.live.has(rule.id)) return this.statusOf(rule.id);
    const l: Live = { rule, status: { id: rule.id, state: "starting", active: 0, total: 0 }, sockets: new Set() };
    this.live.set(rule.id, l);

    try {
      if (rule.kind === "local" || rule.kind === "dynamic") this.startLocalListener(l);
      else this.startRemoteListener(l);
    } catch (e) {
      this.fail(l, e);
    }
    return { ...l.status };
  }

  stop(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    try { l.server?.close(); } catch { /* ignore */ }
    for (const s of l.sockets) { try { s.destroy(); } catch { /* ignore */ } }
    l.sockets.clear();
    if (l.rule.kind === "remote" && l.remotePort !== undefined) {
      const client = this.clientFor(l.rule.hostId);
      try { client?.unforwardIn(l.rule.remoteBindAddress || "0.0.0.0", l.remotePort); } catch { /* ignore */ }
    }
    this.statusSink({ id, state: "stopped", active: 0, total: l.status.total });
  }

  stopAll(): void { for (const id of Array.from(this.live.keys())) this.stop(id); }

  private clientFor(hostId: string): Client | undefined {
    return this.channelFor(hostId);
  }

  private fail(l: Live, e: unknown): void {
    l.status.state = "error";
    l.status.error = String((e as Error)?.message ?? e);
    this.emit(l);
    this.live.delete(l.rule.id);
  }

  /** local(-L)与 dynamic(-D,内建 SOCKS5)都在本机监听 */
  private startLocalListener(l: Live): void {
    const { rule } = l;
    const server = net.createServer((sock) => {
      l.sockets.add(sock);
      sock.on("close", () => l.sockets.delete(sock));
      sock.on("error", () => { try { sock.destroy(); } catch { /* ignore */ } });
      this.bump(l, 1);

      if (rule.kind === "dynamic") {
        this.handleSocks5(l, sock);
        return;
      }
      this.forwardOut(l, sock, rule.destinationAddress, rule.destinationPort);
    });

    server.on("error", (e) => this.fail(l, e));
    server.listen(rule.port, rule.bindAddress || "0.0.0.0", () => {
      const addr = server.address();
      l.server = server;
      l.status.state = "running";
      l.status.boundPort = typeof addr === "object" && addr ? addr.port : rule.port;
      this.emit(l);
    });
  }

  /** 一条本地连接 → 经 ssh 通道连到远端目标 */
  private forwardOut(l: Live, sock: net.Socket, dstAddr: string, dstPort: number): void {
    const client = this.clientFor(l.rule.hostId);
    if (!client) { try { sock.destroy(); } catch { /* ignore */ } this.fail(l, new Error(tr("err.sshUnavailable"))); return; }
    const src = sock.remoteAddress ?? "127.0.0.1";
    const srcPort = sock.remotePort ?? 0;
    client.forwardOut(src, srcPort, dstAddr, dstPort, (err, stream) => {
      if (err) { try { sock.destroy(); } catch { /* ignore */ } this.bump(l, -1); return; }
      sock.pipe(stream).pipe(sock);
      const done = (): void => {
        try { stream.destroy(); } catch { /* ignore */ }
        try { sock.destroy(); } catch { /* ignore */ }
        this.bump(l, -1);
      };
      stream.on("close", done);
      stream.on("error", done);
      sock.on("close", done);
    });
  }

  /** SSH 远端监听(-R) */
  private startRemoteListener(l: Live): void {
    const { rule } = l;
    const client = this.clientFor(rule.hostId);
    if (!client) { this.fail(l, new Error(tr("err.sshUnavailable"))); return; }
    const bindAddr = rule.remoteBindAddress || "0.0.0.0";

    client.on("tcp connection", (_info: unknown, accept: () => NodeJS.ReadWriteStream, reject: () => void) => {
      if (!this.live.has(rule.id)) { reject(); return; }
      let stream: NodeJS.ReadWriteStream;
      try { stream = accept(); } catch { reject(); return; }
      this.bump(l, 1);
      const target = net.connect(rule.destinationPort, rule.destinationAddress);
      target.on("connect", () => { target.pipe(stream).pipe(target); });
      const done = (): void => {
        try { target.destroy(); } catch { /* ignore */ }
        try { (stream as unknown as net.Socket).destroy?.(); } catch { /* ignore */ }
        this.bump(l, -1);
      };
      target.on("close", done);
      target.on("error", done);
      (stream as unknown as net.Socket).on?.("close", done);
    });

    client.forwardIn(bindAddr, rule.port, (err, port) => {
      if (err) { this.fail(l, err); return; }
      l.remotePort = port;
      l.status.state = "running";
      l.status.boundPort = port;
      this.emit(l);
    });
  }

  /** dynamic:最小可用的 SOCKS5(CONNECT,无认证),按目标动态建通道 */
  private handleSocks5(l: Live, sock: net.Socket): void {
    let stage = 0;
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 3) return;
        if (!isSocks5(buf)) { sock.destroy(); return; }
        sock.write(Buffer.from([0x05, 0x00])); // 无需认证
        buf = buf.subarray(buf.length); // 余量留着解析请求
        buf = Buffer.alloc(0);
        stage = 1;
        return;
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host = "";
        let port = 0;
        let need = 0;
        if (atyp === 0x01) { need = 4 + 4 + 2; if (buf.length < need) return; host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`; port = buf.readUInt16BE(8); }
        else if (atyp === 0x03) { const len = buf[4]; need = 4 + 1 + len + 2; if (buf.length < need) return; host = buf.subarray(5, 5 + len).toString("utf8"); port = buf.readUInt16BE(5 + len); }
        else if (atyp === 0x04) { need = 4 + 16 + 2; if (buf.length < need) return; host = Array.from(buf.subarray(4, 20)).map((b, i) => (i % 2 === 0 ? b.toString(16) : b.toString(16))).join("").replace(/(.{4})(?=.)/g, "$1:"); port = buf.readUInt16BE(20); }
        else { sock.destroy(); return; }

        sock.removeListener("data", onData);
        const client = this.clientFor(l.rule.hostId);
        if (!client) { sock.destroy(); return; }
        client.forwardOut(sock.remoteAddress ?? "127.0.0.1", sock.remotePort ?? 0, host, port, (err, stream) => {
          if (err) {
            sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // 一般性失败
            sock.destroy();
            this.bump(l, -1);
            return;
          }
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          sock.pipe(stream).pipe(sock);
          const done = (): void => {
            try { stream.destroy(); } catch { /* ignore */ }
            try { sock.destroy(); } catch { /* ignore */ }
            this.bump(l, -1);
          };
          stream.on("close", done);
          stream.on("error", done);
          sock.on("close", done);
        });
      }
    };
    sock.on("data", onData);
  }
}
