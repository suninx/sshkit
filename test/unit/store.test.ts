import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmDir, tmpDir } from "../helpers/tmp";
import { HostStore, expandHome } from "../../src/main/store";
import type { HostInput } from "../../src/shared/host";

const base: HostInput = {
  name: "node-1", host: "192.0.2.10", port: 22, username: "root",
  authType: "password", group: "Prod", tags: ["prod"],
};

let dir: string;
beforeEach(() => { dir = tmpDir("sshkit-store-"); });
afterEach(() => rmDir(dir));

describe("HostStore", () => {
  it("创建后可列出/按 id 取回,并落盘(新实例能读回)", () => {
    const s = new HostStore(dir);
    const rec = s.create(base);
    expect(rec.id).toMatch(/^h_/);
    expect(s.list()).toHaveLength(1);
    expect(s.get(rec.id)?.name).toBe("node-1");

    const again = new HostStore(dir);
    expect(again.list().map((h) => h.name)).toEqual(["node-1"]);
  });

  it("未给 name 时用 host 兜底", () => {
    const s = new HostStore(dir);
    const rec = s.create({ ...base, name: "   " });
    expect(rec.name).toBe("192.0.2.10");
  });

  it("校验:缺主机 / 端口越界 / 未知认证方式 / key 缺路径 都会拒绝", () => {
    const s = new HostStore(dir);
    expect(() => s.create({ ...base, host: "" })).toThrow(/host/i);
    expect(() => s.create({ ...base, host: "a b" })).toThrow(/host/i);
    expect(() => s.create({ ...base, port: 0 })).toThrow(/port/i);
    expect(() => s.create({ ...base, port: 70000 })).toThrow(/port/i);
    expect(() => s.create({ ...base, authType: "nope" as never })).toThrow(/authType/i);
    expect(() => s.create({ ...base, authType: "key", keyPath: "" })).toThrow(/keyPath/i);
    expect(s.list()).toHaveLength(0);
  });

  it("更新会做同样的校验,失败时原记录不变", () => {
    const s = new HostStore(dir);
    const rec = s.create(base);
    const upd = s.update(rec.id, { name: "renamed" });
    expect(upd.name).toBe("renamed");
    expect(() => s.update(rec.id, { port: -1 })).toThrow(/port/i);
    expect(s.get(rec.id)?.port).toBe(22);
  });

  it("删除后不再出现在列表里,且落盘", () => {
    const s = new HostStore(dir);
    const rec = s.create(base);
    s.remove(rec.id);
    expect(s.list()).toHaveLength(0);
    expect(new HostStore(dir).list()).toHaveLength(0);
  });

  it("hosts.json 损坏时不应崩,按空列表启动", () => {
    fs.writeFileSync(path.join(dir, "hosts.json"), "{not json");
    const s = new HostStore(dir);
    expect(s.list()).toEqual([]);
  });
});

describe("expandHome()", () => {
  it("展开 ~ 与 ~/x,其余原样", () => {
    expect(expandHome("~")).toBe(os.homedir());
    expect(expandHome("~/x/y")).toBe(path.join(os.homedir(), "x/y"));
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("rel")).toBe("rel");
  });
});
