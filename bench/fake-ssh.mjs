// bench/fake-ssh.mjs —— 本地假 SSH 服务,用于隔离测试"主机密钥询问"(T6)。
// 为什么需要:真实 LAN 主机的密钥都已在用户的 known_hosts 里,无法触发"未知主机";
// 又不该为了测试去改用户的 ssh 配置。故起一个只呈现主机密钥的本地服务。
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
const { Server } = ssh2;

// 主机密钥固定下来:否则每次重启都换密钥,会触发"指纹变更",无法稳定测断线/重连
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
const KEY_FILE = new URL("./.run/fake-ssh-key.pem", import.meta.url).pathname;
let privateKey;
if (existsSync(KEY_FILE)) {
  privateKey = readFileSync(KEY_FILE, "utf8");
} else {
  ({ privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  }));
  mkdirSync(new URL("./.run/", import.meta.url).pathname, { recursive: true });
  writeFileSync(KEY_FILE, privateKey);
}
const port = Number(process.argv[2] || 2222);

new Server({ hostKeys: [privateKey] }, (client) => {
  console.log("[fake-ssh] 有客户端连入");
  client.on("close", () => console.log("[fake-ssh] 客户端断开"));
  client.on("end", () => console.log("[fake-ssh] 客户端 end"));
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
