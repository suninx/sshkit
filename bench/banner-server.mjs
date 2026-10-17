// 一个只回答 banner 的本地 TCP 服务,用于验证转发链路真的把流量送到了"目的端"
import net from "node:net";
const port = Number(process.argv[2] || 19091);
let n = 0;
net.createServer((s) => {
  n++;
  console.log(`[banner] 收到第 ${n} 个连接 from ${s.remoteAddress}:${s.remotePort}`);
  s.write(`BANNER-${n}-OK\n`);
  setTimeout(() => s.destroy(), 300);
}).listen(port, "127.0.0.1", () => console.log(`[banner] 监听 127.0.0.1:${port}`));
