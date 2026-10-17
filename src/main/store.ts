import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostInput, HostRecord } from "../shared/host";

/**
 * Host book — local JSON store in Electron userData.
 * Secrets NEVER live here; they go to the OS keychain (keystore.ts).
 */
export class HostStore {
  private file: string;
  private hosts: HostRecord[] = [];

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, "hosts.json");
    this.load();
  }

  list(): HostRecord[] {
    return this.hosts;
  }

  get(id: string): HostRecord | undefined {
    return this.hosts.find((h) => h.id === id);
  }

  create(input: HostInput): HostRecord {
    const rec: HostRecord = {
      ...this.validate(input),
      id: `h_${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    this.hosts.push(rec);
    this.save();
    return rec;
  }

  update(id: string, patch: Partial<HostInput>): HostRecord {
    const idx = this.hosts.findIndex((h) => h.id === id);
    if (idx < 0) throw new Error(`unknown host id: ${id}`);
    const merged = this.validate({ ...this.hosts[idx], ...patch } as HostInput);
    this.hosts[idx] = { ...merged, id, createdAt: this.hosts[idx].createdAt };
    this.save();
    return this.hosts[idx];
  }

  remove(id: string): void {
    this.hosts = this.hosts.filter((h) => h.id !== id);
    this.save();
  }

  private validate(input: HostInput): HostInput {
    const host = String(input.host ?? "").trim();
    if (!host || host.includes(" ")) throw new Error("host is required");
    const port = Number(input.port ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${port}`);
    const username = String(input.username ?? "").trim();
    if (!username) throw new Error("username is required");
    const authType = input.authType;
    if (authType !== "password" && authType !== "key" && authType !== "agent") {
      throw new Error(`invalid authType: ${String(authType)}`);
    }
    if (authType === "key" && !String(input.keyPath ?? "").trim()) throw new Error("keyPath required for key auth");
    return {
      name: String(input.name ?? "").trim() || host,
      group: input.group ? String(input.group).trim() : undefined,
      keyPath: input.keyPath ? String(input.keyPath).trim() : undefined,
      host, port, username, authType,
    };
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { hosts?: HostRecord[] };
      this.hosts = Array.isArray(raw.hosts) ? raw.hosts : [];
    } catch {
      this.hosts = []; // first run or corrupt file — start empty, never crash the app over it
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, hosts: this.hosts }, null, 2));
    renameSync(tmp, this.file); // atomic on same volume
  }
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
