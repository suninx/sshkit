/* 「主机 id → SFTP 连接」池。MCP 客户端没有终端会话,所以不能复用界面上的
   SshService 会话,而是按需给每台主机开一条**专用**连接(与 SftpController 的
   aux 连接同一思路),闲置一段时间后自动关掉,免得 AI 调一次就漏一条连接。
   连接由外部注入(主进程才知道主机与凭据),因此这里可以脱离 Electron 单测。 */

import type { SftpLike } from "./remote";

export interface PooledConn {
  sftp: SftpLike;
  close(): void;
}

export class RemotePool {
  private readonly entries = new Map<string, { conn: PooledConn; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly open: (hostId: string) => Promise<PooledConn>,
    private readonly idleMs = 120_000,
  ) {}

  async get(hostId: string): Promise<PooledConn> {
    const hit = this.entries.get(hostId);
    if (hit) {
      this.arm(hostId, hit);
      return hit.conn;
    }
    const conn = await this.open(hostId);
    const entry = { conn, timer: this.startIdle(hostId, conn) };
    this.entries.set(hostId, entry);
    return conn;
  }

  /** 关掉某台主机的连接(测试或手动断线用) */
  drop(hostId: string): void {
    const hit = this.entries.get(hostId);
    if (!hit) return;
    clearTimeout(hit.timer);
    this.entries.delete(hostId);
    hit.conn.close();
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.drop(id);
  }

  get size(): number { return this.entries.size; }

  private startIdle(hostId: string, conn: PooledConn): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      /* 空闲到期:关连接并清掉条目(drop/closeAll 会 clearTimeout,所以这里不会重复关) */
      this.entries.delete(hostId);
      conn.close();
    }, this.idleMs);
    timer.unref?.();
    return timer;
  }

  private arm(hostId: string, entry: { conn: PooledConn; timer: ReturnType<typeof setTimeout> }): void {
    clearTimeout(entry.timer);
    entry.timer = this.startIdle(hostId, entry.conn);
  }
}
