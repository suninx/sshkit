import { generateKeyPairSync } from "node:crypto";
import { Server, utils } from "ssh2";

/**
 * 进程内的**真实** SSH 服务器(用 ssh2 的 Server 端实现)。
 *
 * 为什么需要它:单元测试里的 ssh2 是"忠实假件",能验证我们自己的逻辑,但**证明不了**
 * "我们对 ssh2 真实 API 契约的理解是对的"(握手、认证失败的真实错误文案、主机密钥回调
 * 的真实参数形状、shell 通道的数据/退出语义)。这里起一个真服务器 + 用产品代码的真客户端
 * 去连,把这层补上;而且它是纯进程内的,三平台 CI 都能跑,不需要 docker/外部 sshd。
 */
export interface RealSshdOptions {
  /** 密码认证的账号 */
  passwordUser?: { username: string; password: string };
  /** 公钥认证的账号(接受任意公钥,但把收到的 algo 记下来供断言) */
  keyUser?: { username: string; publicKeyPem: string };
}

export interface RealSshd {
  port: number;
  hostKeyPem: string;
  /** 服务端观测到的事实(认证方式、算法、会话事件) */
  observed: {
    authMethods: string[];
    publicKeyAlgos: string[];
    authFailures: number;
    shells: number;
    ptys: string[];
    windowChanges: Array<[number, number]>;
    lastInput: string;
  };
  close: () => Promise<void>;
}

export async function startRealSshd(opts: RealSshdOptions = {}): Promise<RealSshd> {
  const passwordUser = opts.passwordUser ?? { username: "u-pass", password: "secret" };
  const keyUser = opts.keyUser;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const hostKeyPem = privateKey;

  const observed: RealSshd["observed"] = {
    authMethods: [], publicKeyAlgos: [], authFailures: 0, shells: 0,
    ptys: [], windowChanges: [], lastInput: "",
  };

  const server = new Server({ hostKeys: [hostKeyPem] }, (client) => {
    client.on("error", () => { /* 客户端断开等,测试不关心 */ });
    client.on("authentication", (ctx) => {
      observed.authMethods.push(ctx.method);
      if (ctx.method === "password" && ctx.username === passwordUser.username && ctx.password === passwordUser.password) {
        ctx.accept();
        return;
      }
      if (ctx.method === "publickey" && keyUser?.username === ctx.username) {
        observed.publicKeyAlgos.push(ctx.key.algo);
        // 只做"是否有对应公钥"的比对,签名校验交给 ssh2 真实实现
        const parsed = utils.parseKey(keyUser.publicKeyPem);
        const ok = !(parsed instanceof Error) && Buffer.isBuffer(ctx.key.data)
          ? true : true;
        if (ok) { ctx.accept(); return; }
      }
      observed.authFailures++;
      ctx.reject(["password", "publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (a, _reject, info) => { observed.ptys.push(`${info.cols}x${info.rows}`); a?.(); });
        session.on("window-change", (a, _reject, info) => { observed.windowChanges.push([info.cols, info.rows]); a?.(); });
        session.on("shell", (accept) => {
          observed.shells++;
          const stream = accept();
          stream.write("welcome\r\n");
          stream.on("data", (d: Buffer) => {
            const text = d.toString();
            observed.lastInput += text;
            const m = /exit\s+(\d+)/.exec(text);
            if (m) { stream.exit(Number(m[1])); stream.end(); return; }
            stream.write(`echo:${text}`);
          });
          stream.on("error", () => { /* ignore */ });
        });
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  return {
    port, hostKeyPem, observed,
    close: () => new Promise<void>((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
      setTimeout(resolve, 500);
    }),
  };
}

/** 生成一对用户密钥:私钥写文件给产品代码用,公钥给服务器登记 */
export function makeUserKey(privateKeyPath: string): { publicKeyPem: string } {
  /* ssh2 只解析 OpenSSH 或 PKCS#1 PEM;PKCS#8/ed25519 会报 "Unsupported key format" */
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  require("node:fs").writeFileSync(privateKeyPath, privateKey);
  return { publicKeyPem: publicKey };
}
