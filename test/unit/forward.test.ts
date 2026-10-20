import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmDir, tmpDir } from "../helpers/tmp";
import { ForwardService } from "../../src/main/forward";
import type { ForwardRule, ForwardStatus } from "../../src/main/forward";

let dir: string;
let statuses: ForwardStatus[];

/** 取一个当前空闲的本地端口(避免用例之间抢端口) */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });

/** 注意字段名与 main/forward.ts 的 ForwardRule 一致(port/bindAddress/destinationAddress…) */
const rule = (over: Partial<ForwardRule> = {}): ForwardRule => ({
  id: "r1", hostId: "h1", kind: "local",
  bindAddress: "127.0.0.1", port: 0,
  destinationAddress: "127.0.0.1", destinationPort: 80,
  ...over,
});

beforeEach(() => {
  dir = tmpDir("sshkit-fwd-");
  statuses = [];
});
afterEach(() => rmDir(dir));

const make = (client = undefined as never) =>
  new ForwardService(dir, () => client, (s: ForwardStatus) => statuses.push(s));

describe("ForwardService 规则持久化", () => {
  it("初始为空;保存后可列出,并落盘", () => {
    const f = make();
    expect(f.listRules()).toEqual([]);
    const saved = f.saveRule(rule());
    expect(saved.id).toBeTruthy();
    expect(f.listRules()).toHaveLength(1);
    expect(new ForwardService(dir, () => undefined, () => {}).listRules()).toHaveLength(1);
  });

  it("同一 id 再保存是更新而不是新增", () => {
    const f = make();
    const a = f.saveRule(rule({ id: "" as never } as Partial<ForwardRule>));
    f.saveRule({ ...a, port: 18081 });
    const list = f.listRules();
    expect(list).toHaveLength(1);
    expect(list[0].port).toBe(18081);
  });

  it("删除后不再出现", () => {
    const f = make();
    const a = f.saveRule(rule());
    f.deleteRule(a.id);
    expect(f.listRules()).toEqual([]);
  });

  it("forwards.json 损坏时按空列表处理(不崩)", () => {
    const f = make();
    f.saveRule(rule());
    fs.writeFileSync(path.join(dir, "forwards.json"), "{oops");
    expect(f.listRules()).toEqual([]);
  });
});

describe("ForwardService 状态机", () => {
  it("未启动时状态是 idle/unknown,而不是抛错", () => {
    const f = make();
    const a = f.saveRule(rule());
    const st = f.statusOf(a.id);
    expect(st).toBeTruthy();
    expect(st.state).toMatch(/idle|unknown|stopped/i);
    expect(f.listStatuses()).toHaveLength(1);
  });

  it("本地转发先监听;真正连进来时把\"没有 ssh 会话\"作为 error 报出来(而不是静默)", async () => {
    const f = make();
    const port = await freePort();
    const a = f.saveRule(rule({ port }));
    expect(["starting", "running"]).toContain(f.start(a).state);

    /* 保持连接打开:转发链路在 accept 之后就尝试建立 ssh 通道,
       没有会话时必须通过 statusSink 报告 error(实测发现 fail() 会同时清掉 live 条目,
       所以状态以 sink 上的最后一次为准)。 */
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => {
      sock.once("connect", () => resolve());
      sock.once("error", () => resolve());
      setTimeout(resolve, 2000);
    });
    for (let i = 0; i < 60 && !statuses.some((s) => s.state === "error"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    sock.destroy();

    /* 期望行为:失败原因必须能被 statusOf 读到(否则界面重绘后只剩 stopped) */
    const failed = statuses.filter((s) => s.state === "error");
    expect(failed.length).toBeGreaterThan(0);
    expect(String(failed[0].error ?? "")).toMatch(/ssh/i);
    expect(f.statusOf(a.id).state).toBe("error");
    expect(String(f.statusOf(a.id).error ?? "")).toMatch(/ssh/i);

    /* 期望行为:error 状态下允许重试(Start 按钮不该被永久卡住) */
    const retried = f.start(a);
    expect(["starting", "running"]).toContain(retried.state);

    f.stop(a.id);
    expect(f.statusOf(a.id).state).toBe("stopped");
  });

  it("stop() 对未启动的规则是安全的(幂等)", () => {
    const f = make();
    const a = f.saveRule(rule());
    expect(() => f.stop(a.id)).not.toThrow();
    expect(() => f.stop("nope")).not.toThrow();
    expect(() => f.stopAll()).not.toThrow();
  });
});
