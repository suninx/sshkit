/**
 * Smoke test: connect with saved credentials through the REAL known_hosts
 * pinning path, printing every verdict. Run without the UI:
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke-ssh.js <hostIp?>
 *
 * ELECTRON_RUN_AS_NODE gives us Electron's Node ABI so keytar.node (built for
 * Electron) loads; plain `node` would refuse the module.
 */
process.env.ELECTRON_RUN_AS_NODE = "1";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("ssh2");
const keytar = require("keytar");

const want = process.argv[2];

(async () => {
  const storePath = path.join(os.homedir(), "Library", "Application Support", "sshkit", "hosts.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const hosts = store.hosts.filter((h) => !want || h.host === want);
  if (hosts.length === 0) { console.log("no matching host in store; available:", store.hosts.map((h) => h.host).join(", ")); process.exit(1); }
  const host = hosts[0];

  const secrets = host.authType === "agent" ? {} : JSON.parse((await keytar.getPassword("sshkit", `host:${host.id}`)) ?? "{}");

  const cfg = {
    host: host.host, port: host.port, username: host.username,
    keepaliveInterval: 10000, readyTimeout: 10000,
  };
  if (host.authType === "password") cfg.password = secrets.password;
  if (host.authType === "key") { cfg.privateKey = fs.readFileSync(host.keyPath.replace(/^~(?=\/|$)/, os.homedir())); if (secrets.passphrase) cfg.passphrase = secrets.passphrase; }
  if (host.authType === "agent") cfg.agent = process.env.SSH_AUTH_SOCK;

  const known = fs.readFileSync(path.join(os.homedir(), ".ssh", "known_hosts"), "utf8");

  cfg.hostVerifier = (key, verify) => {
    const blob = Buffer.from(key);
    const line = known.split("\n").find((l) => l.startsWith(`${host.host} `) && l.includes(" "));
    const stored = line ? line.split(" ")[2] : null;
    const match = stored ? Buffer.from(stored, "base64").equals(blob) : false;
    const len = blob.readUint32BE(0);
    const algo = blob.toString("utf8", 4, 4 + len);
    console.log("[verifier] algo:", algo, "| bytes:", blob.length, "| pinned in known_hosts:", !!stored, "| MATCHES:", match);
    verify(match || !stored ? true : false); // TOFU only when absent; mismatch refuses
    if (match || !stored) setTimeout(() => process.exit(0), 1500);
  };

  const c = new Client();
  c.on("error", (e) => { console.log("[error]", e.message); process.exit(2); });
  c.on("ready", () => console.log("[ready] handshanke verified, auth OK → PASS"));
  c.connect(cfg);
})();
