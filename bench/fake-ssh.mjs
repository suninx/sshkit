// bench/fake-ssh.mjs —— 本地假 SSH 服务,用于隔离测试"主机密钥询问"(T6)。
// 为什么需要:真实 LAN 主机的密钥都已在用户的 known_hosts 里,无法触发"未知主机";
// 又不该为了测试去改用户的 ssh 配置。故起一个只呈现主机密钥的本地服务。
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
const { Server } = ssh2;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});
const port = Number(process.argv[2] || 2222);

new Server({ hostKeys: [privateKey] }, (client) => {
  console.log("[fake-ssh] 有客户端连入");
  client.on("authentication", (ctx) => {
    console.log("[fake-ssh] auth:", ctx.method, ctx.username);
    ctx.accept(); // 任何认证都接受,方便走完后续流程
  }).on("ready", () => {
    console.log("[fake-ssh] ready,开一个 shell");
    client.on("session", (accept) => {
      const s = accept();
      s.on("pty", () => {});
      s.on("shell", () => { s.write("fake-ssh ready\r\n"); });
    });
  }).on("error", (e) => console.log("[fake-ssh] client error:", e.message));
}).listen(port, "127.0.0.1", () => console.log(`[fake-ssh] 监听 127.0.0.1:${port}`));
