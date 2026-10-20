import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmDir, tmpDir } from "../helpers/tmp";
import { ForwardService } from "../../src/main/forward";
import type { ForwardRule, ForwardStatus } from "../../src/main/forward";

/**
 * forward.ts 覆盖率补齐:规则持久化失败路径、remote(-R) 的 "tcp connection" 回调、
 * 以及 dynamic(-D) 的 SOCKS5 握手全部分支。
 *
 * 这些用例锁的是**行为**:
 *  - 写入规则失败时不能静默(console.error)且不能抛给调用方;
 *  - SOCKS5 只有 CONNECT 一种命令,合法目标要精确解析(IPv4/域名/IPv6)并交给 ssh 通道,
 *    非法握手必须断开而不是挂住;
 *  - -R 的连接要么被接受并接到 destination,要么被 reject(规则已停时)。
 */

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });

const rule = (over: Partial<ForwardRule> = {}): ForwardRule => ({
  id: "r1",
  hostId: "h1",
  kind: "local",
  bindAddress: "127.0.0.1",
  port: 0,
  destinationAddress: "127.0.0.1",
  destinationPort: 80,
  ...over,
});

class FakeClient extends EventEmitter {
  forwardIn = vi.fn((_a: string, _p: number, cb: (e: Error | null, port: number) => void) => cb(null, 40000));
  unforwardIn = vi.fn();
  end = vi.fn();
  forwardOut = vi.fn(
    (_src: string, _srcPort: number, _dst: string, _dstPort: number, cb: (e: Error | null, s: unknown) => void) => {
      cb(null, new PassThrough());
    },
  );
}

/** 只用于白盒投递的假 socket:能收 data/close 事件、记录 write,并可被 pipe(真实连接上不会缺 remoteAddress) */
class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  remoteAddress?: string;
  remotePort?: number;
  private dest: PassThrough | null = null;
  write(d: Buffer): boolean {
    this.written.push(Buffer.from(d));
    return true;
  }
  pipe(dest: PassThrough): PassThrough {
    this.dest = dest;
    return dest;
  }
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
  get downstream(): PassThrough | null {
    return this.dest;
  }
}

let dir: string;
let statuses: ForwardStatus[];

beforeEach(() => {
  dir = tmpDir("sshkit-cov-fwd-");
  statuses = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  rmDir(dir);
});

const make = (lookup: () => FakeClient | undefined, userDataDir = dir): ForwardService =>
  new ForwardService(userDataDir, () => lookup() as never, (s) => statuses.push(s));

const waitFor = async (pred: () => boolean, what = "condition"): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
};

const connectTo = (port: number): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });

const closed = (s: net.Socket): Promise<void> => new Promise((r) => s.once("close", () => r()));

const startDynamic = async (lookup: () => FakeClient | undefined): Promise<{ svc: ForwardService; port: number }> => {
  const svc = make(lookup);
  const r = rule({ id: "dyn", kind: "dynamic", destinationAddress: "", destinationPort: 0 });
  svc.saveRule(r);
  svc.start(r);
  await waitFor(() => svc.statusOf("dyn").state === "running", "dynamic listening");
  return { svc, port: svc.statusOf("dyn").boundPort! };
};

/** 让前一次 write 先被服务端读走,避免 TCP 把小片段合并成一个 chunk(否则分片分支测不到) */
const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

/** 读一次 SOCKS5 服务端回应(定长 2 或 10 字节,做成"收到即返回"便于断言) */
const nextChunk = (sock: net.Socket): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no data from socks server")), 2000);
    sock.once("data", (d) => {
      clearTimeout(timer);
      resolve(d as Buffer);
    });
  });

describe("规则持久化:失败必须可见且不抛", () => {
  it("forwards.json 内容不是数组时按空列表处理", () => {
    fs.writeFileSync(path.join(dir, "forwards.json"), JSON.stringify({ oops: true }));
    expect(make(() => undefined).listRules()).toEqual([]);
  });

  it("userData 目录不可写时 saveRule 不抛,但错误必须打到 stderr(console.error)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const badDir = path.join(dir, "missing-parent", "userData");
    const svc = make(() => undefined, badDir);
    const saved = svc.saveRule(rule({ id: "unwritable" }));
    expect(saved.id).toBe("unwritable");
    expect(errSpy).toHaveBeenCalledWith("[fwd] 规则写入失败:", expect.anything());
    // 行为:没写进去就是没写进去,读回为空而不是半个 JSON
    expect(svc.listRules()).toEqual([]);
  });
});

describe("start(): 幂等、重试与同步异常", () => {
  it("running 状态重复 start 是幂等的(不会重复 forwardIn)", async () => {
    const client = new FakeClient();
    const svc = make(() => client);
    const r = rule({ id: "i1", kind: "remote" });
    svc.saveRule(r);
    svc.start(r);
    await waitFor(() => svc.statusOf("i1").state === "running");
    const again = svc.start(r);
    expect(again.state).toBe("running");
    expect(client.forwardIn).toHaveBeenCalledTimes(1);
    svc.stop("i1");
  });

  it("error 状态允许重试:清掉旧 server 后用新结果重跑", async () => {
    const client = new FakeClient();
    client.forwardIn.mockImplementation((_a: string, _p: number, cb: (e: Error | null, port: number) => void) => {
      cb(new Error("bind denied"), 0);
    });
    const svc = make(() => client);
    const r = rule({ id: "i2", kind: "remote" });
    svc.saveRule(r);
    svc.start(r);
    expect(svc.statusOf("i2")).toMatchObject({ state: "error", error: "bind denied" });

    client.forwardIn.mockImplementation((_a: string, _p: number, cb: (e: Error | null, port: number) => void) => {
      cb(null, 41000);
    });
    const retried = svc.start(r);
    expect(retried).toMatchObject({ state: "running", boundPort: 41000 });
    expect(client.forwardIn).toHaveBeenCalledTimes(2);
    svc.stop("i2");
  });

  it("监听端口非法时进入 error 且原因可读(port out of range)", () => {
    const svc = make(() => undefined);
    const r = rule({ id: "badport", kind: "local", port: 70000 });
    svc.saveRule(r);
    const st = svc.start(r);
    expect(st.state).toBe("error");
    expect(String(st.error)).toMatch(/port/i);
  });

  it("远端监听同步抛出**字符串**时也能报出可读原因(非 Error 也要兜住)", () => {
    const client = new FakeClient();
    client.forwardIn.mockImplementation(() => {
      throw "ssh channel exploded";
    });
    const svc = make(() => client);
    const r = rule({ id: "strerr", kind: "remote" });
    svc.saveRule(r);
    const st = svc.start(r);
    expect(st).toMatchObject({ state: "error", error: "ssh channel exploded" });
  });
});

describe("local(-L):监听与数据通道", () => {
  it("bindAddress 为空串时退回 0.0.0.0 监听,并回报系统分配端口", async () => {
    const svc = make(() => undefined);
    const r = rule({ id: "any", kind: "local", port: 0, bindAddress: "" });
    svc.saveRule(r);
    svc.start(r);
    await waitFor(() => svc.statusOf("any").state === "running");
    expect(svc.statusOf("any").boundPort).toBeGreaterThan(0);
    svc.stop("any");
  });

  it("监听端口已被占用时进入 error 并说清原因(EADDRINUSE 不能静默)", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const busyPort = (blocker.address() as net.AddressInfo).port;
    try {
      const svc = make(() => undefined);
      const r = rule({ id: "busy", kind: "local", port: busyPort });
      svc.saveRule(r);
      svc.start(r);
      await waitFor(() => svc.statusOf("busy").state === "error", "EADDRINUSE");
      expect(String(svc.statusOf("busy").error)).toMatch(/EADDRINUSE|address already in use/i);
      svc.stop("busy");
    } finally {
      blocker.close();
    }
  });

  it("某条本地连接 socket 报错时只销毁该连接,规则继续 running", async () => {
    const client = new FakeClient();
    client.forwardOut.mockImplementation(() => undefined); // 通道迟迟不回调
    const svc = make(() => client);
    const r = rule({ id: "soer", kind: "local", port: 0 });
    svc.saveRule(r);
    svc.start(r);
    await waitFor(() => svc.statusOf("soer").state === "running");
    const internals = svc as unknown as { live: Map<string, { server?: net.Server }> };
    const fakeSock = new FakeSocket();
    internals.live.get("soer")!.server!.emit("connection", fakeSock);
    fakeSock.emit("error", new Error("ECONNRESET"));
    expect(fakeSock.destroyed).toBe(true);
    expect(svc.statusOf("soer").state).toBe("running");
    svc.stop("soer");
  });

  it("stopAll 停掉全部运行中的规则(监听端口随之关闭)", async () => {
    const client = new FakeClient();
    const svc = make(() => client);
    const a = rule({ id: "sa", kind: "dynamic" });
    const b = rule({ id: "sb", kind: "dynamic" });
    svc.saveRule(a);
    svc.saveRule(b);
    svc.start(a);
    svc.start(b);
    await waitFor(() => svc.statusOf("sa").state === "running" && svc.statusOf("sb").state === "running");
    const portA = svc.statusOf("sa").boundPort!;
    svc.stopAll();
    expect(svc.statusOf("sa").state).toBe("stopped");
    expect(svc.statusOf("sb").state).toBe("stopped");
    // 端口确实释放了:再连会失败(而不是留下半开的监听)
    await expect(connectTo(portA)).rejects.toBeTruthy();
  });

  it("连入后调用 forwardOut(src,dst),双向 pipe,断开时 active 回到 0", async () => {
    const client = new FakeClient();
    const stream = new PassThrough();
    client.forwardOut.mockImplementation((_s, _sp, _d, _dp, cb) => cb(null, stream));
    const svc = make(() => client);
    const r = rule({ id: "l1", kind: "local", port: 0, destinationAddress: "10.9.9.9", destinationPort: 2222 });
    svc.saveRule(r);
    svc.start(r);
    await waitFor(() => svc.statusOf("l1").state === "running");

    const sock = await connectTo(svc.statusOf("l1").boundPort!);
    await waitFor(() => client.forwardOut.mock.calls.length === 1, "forwardOut");
    const [src, srcPort, dst, dstPort] = client.forwardOut.mock.calls[0] as [string, number, string, number];
    expect(src).toBe("127.0.0.1");
    expect(srcPort).toBeGreaterThan(0);
    expect([dst, dstPort]).toEqual(["10.9.9.9", 2222]);

    // 本机 → 远端
    const gotByRemote: Buffer[] = [];
    stream.on("data", (d: Buffer) => gotByRemote.push(d));
    sock.write("hello-remote");
    await waitFor(() => gotByRemote.join("") === "hello-remote", "data into ssh stream");

    // 远端 → 本机
    const gotByLocal: Buffer[] = [];
    sock.on("data", (d: Buffer) => gotByLocal.push(d as Buffer));
    stream.write("hello-local");
    await waitFor(() => gotByLocal.join("").includes("hello-local"), "data into local socket");

    // 远端关闭 → 本机连接关闭、active 归零
    const closedP = closed(sock);
    stream.destroy();
    await closedP;
    await waitFor(() => svc.statusOf("l1").active === 0, "active back to 0");
    svc.stop("l1");
  });

  it("forwardOut 失败时断开本机连接并把 active 减回去(不留下僵尸计数)", async () => {
    const client = new FakeClient();
    client.forwardOut.mockImplementation((_s, _sp, _d, _dp, cb) => cb(new Error("channel denied"), null as never));
    const svc = make(() => client);
    const r = rule({ id: "l2", kind: "local", port: 0 });
    svc.saveRule(r);
    svc.start(r);
    await waitFor(() => svc.statusOf("l2").state === "running");

    const sock = await connectTo(svc.statusOf("l2").boundPort!);
    const closedP = closed(sock);
    await closedP; // 服务端 forwardOut 失败后销毁连接
    await waitFor(() => svc.statusOf("l2").active === 0);
    // 失败也要把"为什么"报出来
    expect(statuses.some((s) => s.state === "error" && /channel denied/.test(String(s.error)))).toBe(false);
    expect(statuses.some((s) => s.id === "l2" && s.active === 0)).toBe(true);
    svc.stop("l2");
  });

  it("socket 缺少 remoteAddress/remotePort 时用 127.0.0.1:0 兜底(白盒:直接投递连接)", async () => {
    const client = new FakeClient();
    const svc = make(() => client);
    const r = rule({ id: "l3", kind: "local", port: 0, destinationAddress: "1.2.3.4", destinationPort: 443 });
    svc.saveRule(r);
    svc.start(r);
    await waitFor(() => svc.statusOf("l3").state === "running");
    const internals = svc as unknown as { live: Map<string, { server?: net.Server }> };
    const server = internals.live.get("l3")!.server!;

    // 真实连接的 socket 一定有 remoteAddress;这里用无地址的假 socket 驱动防御分支。
    const fakeSock = new PassThrough();
    server.emit("connection", fakeSock);
    await waitFor(() => client.forwardOut.mock.calls.length === 1);
    expect(client.forwardOut.mock.calls[0].slice(0, 4)).toEqual(["127.0.0.1", 0, "1.2.3.4", 443]);
    fakeSock.destroy();
    svc.stop("l3");
  });
});

describe("remote(-R):远端连入的回调", () => {
  it("接受连接后接到 destination,数据双向可达;关闭时 active 归零", async () => {
    const echo = net.createServer((s) => {
      s.on("error", () => undefined); // 隧道关闭后 echo 端可能 EPIPE,测试里不关心
      s.write("server-ready\n"); // 证明隧道真的连到了 destination(而不是本地回环假象)
      s.pipe(s);
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    const echoPort = (echo.address() as net.AddressInfo).port;
    try {
      const client = new FakeClient();
      const svc = make(() => client);
      const r = rule({ id: "r1", kind: "remote", port: 0, destinationAddress: "127.0.0.1", destinationPort: echoPort });
      svc.saveRule(r);
      svc.start(r);
      await waitFor(() => svc.statusOf("r1").state === "running");

      const accepted = new PassThrough();
      const reject = vi.fn();
      client.emit("tcp connection", { destPort: echoPort }, () => accepted, reject);

      // 本机(模拟远端对端)→ 隧道 → destination(echo)→ 原路返回
      const got: string[] = [];
      accepted.on("data", (d: Buffer) => got.push(d.toString()));
      // destination 的问候语必须出现:它只有在 target 的 connect 回调接好管道后才会到达
      await waitFor(() => got.join("").includes("server-ready"), "destination reachable");
      accepted.write("ping-through-tunnel");
      await waitFor(() => got.join("").includes("ping-through-tunnel"), "echo roundtrip");
      await waitFor(() => svc.statusOf("r1").active === 1, "active=1");

      const done = new Promise<void>((res) => accepted.once("close", () => res()));
      accepted.destroy();
      await done;
      await waitFor(() => svc.statusOf("r1").active === 0, "active back to 0");
      expect(reject).not.toHaveBeenCalled();
      svc.stop("r1");
    } finally {
      echo.close();
    }
  });

  it("规则已停止后仍在途的连接被 reject(而不是悄悄接到 destination)", async () => {
    const client = new FakeClient();
    const svc = make(() => client);
    const r = rule({ id: "r2", kind: "remote", port: 0 });
    svc.saveRule(r);
    svc.start(r);
    await waitFor(() => svc.statusOf("r2").state === "running");
    svc.stop("r2");

    const accept = vi.fn();
    const reject = vi.fn();
    client.emit("tcp connection", {}, accept, reject);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
  });

  it("accept() 抛错时 reject 该连接,不向未接管的通道写数据", async () => {
    const client = new FakeClient();
    const svc = make(() => client);
    const r = rule({ id: "r3", kind: "remote", port: 0 });
    svc.saveRule(r);
    svc.start(r);
    await waitFor(() => svc.statusOf("r3").state === "running");

    const reject = vi.fn();
    client.emit("tcp connection", {}, () => {
      throw new Error("channel open failed");
    }, reject);
    expect(reject).toHaveBeenCalledTimes(1);
    svc.stop("r3");
  });

  it("destination 连不上时结束该隧道连接,active 归零(错误路径不抛到进程)", async () => {
    const deadPort = await freePort(); // 拿到的端口随后释放,几乎立即 ECONNREFUSED
    const client = new FakeClient();
    const svc = make(() => client);
    const r = rule({ id: "r4", kind: "remote", port: 0, destinationAddress: "127.0.0.1", destinationPort: deadPort });
    svc.saveRule(r);
    svc.start(r);
    await waitFor(() => svc.statusOf("r4").state === "running");

    const accepted = new PassThrough();
    const reject = vi.fn();
    client.emit("tcp connection", {}, () => accepted, reject);
    await waitFor(() => svc.statusOf("r4").active === 0, "active back to 0 after connect error");
    expect(reject).not.toHaveBeenCalled();
    svc.stop("r4");
  });

  it("没有可用 ssh 通道时 remote 规则进入 error 而不是假装 running", () => {
    const svc = make(() => undefined);
    const r = rule({ id: "r5", kind: "remote", port: 0 });
    svc.saveRule(r);
    const st = svc.start(r);
    expect(st.state).toBe("error");
    expect(String(st.error)).toMatch(/ssh/i);
  });

  it("stop 时取消远端监听;通道已消失/取消抛错都不影响 stop 的状态收敛", () => {
    const client = new FakeClient();
    let lookup: FakeClient | undefined = client;
    const svc = make(() => lookup);
    const r = rule({ id: "r6", kind: "remote", port: 0, remoteBindAddress: "127.0.0.1" });
    svc.saveRule(r);
    svc.start(r);
    expect(svc.statusOf("r6")).toMatchObject({ state: "running", boundPort: 40000 });
    client.unforwardIn.mockImplementation(() => {
      throw new Error("channel already gone");
    });
    expect(() => svc.stop("r6")).not.toThrow();
    expect(client.unforwardIn).toHaveBeenCalledWith("127.0.0.1", 40000);
    expect(svc.statusOf("r6").state).toBe("stopped");

    // 通道查不到时 stop 也不抛(可选链分支)
    const client2 = new FakeClient();
    lookup = client2;
    const r2 = rule({ id: "r7", kind: "remote", port: 0 });
    svc.saveRule(r2);
    svc.start(r2);
    lookup = undefined;
    expect(() => svc.stop("r7")).not.toThrow();
    expect(client2.unforwardIn).not.toHaveBeenCalled();
  });
});

/** SOCKS5 request: CONNECT + ATYP。stage 1 至少要先读 5 字节。 */
const socksRequest = (atyp: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), body]);

describe("dynamic(-D):内建 SOCKS5", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("合法握手:问候语分两段到达也能回答 05 00(无认证)", async () => {
    const { svc, port } = await startDynamic(() => new FakeClient());
    const sock = await connectTo(port);
    const reply = nextChunk(sock);
    sock.write(Buffer.from([0x05])); // 长度不足 3:先等
    await pause();
    sock.write(Buffer.from([0x01, 0x00])); // 凑齐 [:05 :01 :00]
    await expect(reply).resolves.toEqual(Buffer.from([0x05, 0x00]));
    sock.destroy();
    svc.stop("dyn");
  });

  it("版本不是 5 时直接断开(不能把非 SOCKS 流量当代理)", async () => {
    const { svc, port } = await startDynamic(() => new FakeClient());
    const sock = await connectTo(port);
    const closedP = closed(sock);
    sock.write(Buffer.from([0x04, 0x01, 0x00]));
    await closedP;
    svc.stop("dyn");
  });

  it("IPv4 CONNECT 分片到达也能正确解析目标并双向转发", async () => {
    const client = new FakeClient();
    const stream = new PassThrough();
    client.forwardOut.mockImplementation((_s, _sp, _d, _dp, cb) => cb(null, stream));
    const { svc, port } = await startDynamic(() => client);
    const sock = await connectTo(port);
    const greet = nextChunk(sock);
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    await expect(greet).resolves.toEqual(Buffer.from([0x05, 0x00]));

    const req = socksRequest(0x01, Buffer.from([1, 2, 3, 4, 0x01, 0xbb])); // 1.2.3.4:443
    const reply = nextChunk(sock);
    sock.write(req.subarray(0, 4)); // < 5 字节:等
    await pause();
    sock.write(req.subarray(4, 8)); // 头部齐了但 IPv4 不足:等
    await pause();
    expect(client.forwardOut).not.toHaveBeenCalled();
    sock.write(req.subarray(8));
    expect(await reply).toEqual(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    expect(client.forwardOut.mock.calls[0].slice(2, 4)).toEqual(["1.2.3.4", 443]);

    // 双向:远端 stream → 客户端
    const got: string[] = [];
    sock.on("data", (d: Buffer) => got.push(d.toString()));
    stream.write("from-target");
    await waitFor(() => got.join("") === "from-target", "target→socks");
    // 客户端 → 远端 stream
    const gotRemote: string[] = [];
    stream.on("data", (d: Buffer) => gotRemote.push(d.toString()));
    sock.write("from-client");
    await waitFor(() => gotRemote.join("") === "from-client", "socks→target");

    const closedP = closed(sock);
    stream.destroy();
    await closedP;
    await waitFor(() => svc.statusOf("dyn").active === 0);
    svc.stop("dyn");
  });

  it("域名 CONNECT(ATYP=3)按长度字段解析主机名", async () => {
    const client = new FakeClient();
    client.forwardOut.mockImplementation((_s, _sp, _d, _dp, cb) => cb(null, new PassThrough()));
    const { svc, port } = await startDynamic(() => client);
    const sock = await connectTo(port);
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    await nextChunk(sock);

    const host = Buffer.from("example.internal", "utf8");
    const req = socksRequest(0x03, Buffer.concat([Buffer.from([host.length]), host, Buffer.from([0x1f, 0x90])]));
    sock.write(req.subarray(0, 6)); // host 还没到齐
    await pause();
    expect(client.forwardOut).not.toHaveBeenCalled();
    sock.write(req.subarray(6));
    await waitFor(() => client.forwardOut.mock.calls.length === 1);
    expect(client.forwardOut.mock.calls[0].slice(2, 4)).toEqual(["example.internal", 8080]);
    sock.destroy();
    svc.stop("dyn");
  });

  it("IPv6 CONNECT(ATYP=4)把 16 字节地址格式化成冒号分组", async () => {
    const client = new FakeClient();
    client.forwardOut.mockImplementation((_s, _sp, _d, _dp, cb) => cb(null, new PassThrough()));
    const { svc, port } = await startDynamic(() => client);
    const sock = await connectTo(port);
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    await nextChunk(sock);

    // 每个字节都 >= 0x10,保证按 4 个 hex 字符一组切分(避免单 nibble 造成的显示歧义)
    const v6 = Buffer.from([0xfe, 0x80, 0x20, 0x21, 0x0a, 0x0b, 0x0c, 0x0d, 0x1a, 0x1b, 0x1c, 0x1d, 0x2a, 0x2b, 0x2c, 0x2d]);
    const req = socksRequest(0x04, Buffer.concat([v6, Buffer.from([0x00, 0x50])]));
    sock.write(req.subarray(0, 10)); // 不足 4+16+2
    await pause();
    sock.write(req.subarray(10, 18));
    await pause();
    expect(client.forwardOut).not.toHaveBeenCalled();
    sock.write(req.subarray(18));
    await waitFor(() => client.forwardOut.mock.calls.length === 1);
    expect(client.forwardOut.mock.calls[0].slice(2, 4)).toEqual(["fe80:2021:abcd:1a1b:1c1d:2a2b:2c2d", 80]);
    sock.destroy();
    svc.stop("dyn");
  });

  it("未知 ATYP 直接断开", async () => {
    const { svc, port } = await startDynamic(() => new FakeClient());
    const sock = await connectTo(port);
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    await nextChunk(sock);
    const closedP = closed(sock);
    sock.write(Buffer.from([0x05, 0x01, 0x00, 0x02, 0x00, 0x00]));
    await closedP;
    svc.stop("dyn");
  });

  it("握手期间 ssh 会话消失时断开,并且 active 归零", async () => {
    const client = new FakeClient();
    let lookup: FakeClient | undefined = client;
    const { svc, port } = await startDynamic(() => lookup);
    const sock = await connectTo(port);
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    await nextChunk(sock);
    lookup = undefined;
    const closedP = closed(sock);
    sock.write(socksRequest(0x01, Buffer.from([9, 9, 9, 9, 0x00, 0x50])));
    await closedP;
    expect(client.forwardOut).not.toHaveBeenCalled();
    svc.stop("dyn");
  });

  it("forwardOut 失败时回 SOCKS 失败应答再断开(而不是写成功)", async () => {
    const client = new FakeClient();
    client.forwardOut.mockImplementation((_s, _sp, _d, _dp, cb) => cb(new Error("no route"), null as never));
    const { svc, port } = await startDynamic(() => client);
    const sock = await connectTo(port);
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    await nextChunk(sock);

    const chunks: Buffer[] = [];
    sock.on("data", (d: Buffer) => chunks.push(d));
    const closedP = closed(sock);
    sock.write(socksRequest(0x01, Buffer.from([8, 8, 8, 8, 0x01, 0xbb])));
    await closedP;
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    await waitFor(() => svc.statusOf("dyn").active === 0);
    svc.stop("dyn");
  });

  it("socket 缺少 remoteAddress/remotePort 时 SOCKS5 用 127.0.0.1:0 兜底(白盒:直接投递连接)", async () => {
    const client = new FakeClient();
    const stream = new PassThrough();
    client.forwardOut.mockImplementation((_s, _sp, _d, _dp, cb) => cb(null, stream));
    const { svc } = await startDynamic(() => client);
    const internals = svc as unknown as { live: Map<string, { server?: net.Server }> };
    await waitFor(() => Boolean(internals.live.get("dyn")?.server), "dynamic server");
    const fakeSock = new FakeSocket();
    internals.live.get("dyn")!.server!.emit("connection", fakeSock);
    fakeSock.emit("data", Buffer.from([0x05, 0x01, 0x00]));
    expect(fakeSock.written[0]).toEqual(Buffer.from([0x05, 0x00]));

    fakeSock.emit("data", socksRequest(0x01, Buffer.from([5, 6, 7, 8, 0x00, 0x50])));
    expect(client.forwardOut).toHaveBeenCalledTimes(1);
    expect(client.forwardOut.mock.calls[0].slice(0, 4)).toEqual(["127.0.0.1", 0, "5.6.7.8", 80]);
    expect(fakeSock.written[1]).toEqual(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    fakeSock.destroy();
    svc.stop("dyn");
  });

  it("目标 stream 报错时回收连接(active 归零,客户端被断开)", async () => {
    const client = new FakeClient();
    const stream = new PassThrough();
    client.forwardOut.mockImplementation((_s, _sp, _d, _dp, cb) => cb(null, stream));
    const { svc, port } = await startDynamic(() => client);
    const sock = await connectTo(port);
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    await nextChunk(sock);
    const reply = nextChunk(sock);
    sock.write(socksRequest(0x01, Buffer.from([7, 7, 7, 7, 0x00, 0x16])));
    await reply;
    await waitFor(() => svc.statusOf("dyn").active === 1);
    const closedP = closed(sock);
    stream.emit("error", new Error("tunnel reset"));
    await closedP;
    await waitFor(() => svc.statusOf("dyn").active === 0);
    svc.stop("dyn");
  });
});
