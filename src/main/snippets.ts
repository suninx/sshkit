import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 片段(Snippets)。原版在终端侧栏里有 `Snippets`(字符串证据见 F34),用于把常用命令一键发到终端。
 * 落盘遵循本项目规矩:① 原子写(tmp + rename)② 失败不静默 ③ 格式边界明确(JSON)。
 */
export interface Snippet {
  id: string;
  name: string;
  command: string;
}

const FILE = path.join(os.homedir(), "Library", "Application Support", "sshkit", "snippets.json");

export class SnippetStore {
  private items: Snippet[] = [];
  private file: string;

  constructor(file = FILE) {
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      const list = Array.isArray(raw) ? raw : [];
      this.items = list
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          id: String(x.id ?? `s${Math.random().toString(36).slice(2, 8)}`),
          name: String(x.name ?? "").slice(0, 120),
          command: String(x.command ?? "").slice(0, 4000),
        }))
        .filter((x) => x.name || x.command);
    } catch {
      this.items = []; // 文件不存在或损坏:从空清单起步,不影响其它功能
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.items, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch (e) {
      console.error("[snippets] 写入失败:", e); // 不静默
    }
  }

  list(): Snippet[] { return this.items; }

  saveSnippet(input: { id?: string; name: string; command: string }): Snippet {
    const name = String(input.name ?? "").slice(0, 120);
    const command = String(input.command ?? "").slice(0, 4000);
    const id = input.id && this.items.some((x) => x.id === input.id)
      ? input.id
      : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const i = this.items.findIndex((x) => x.id === id);
    const item: Snippet = { id, name, command };
    if (i >= 0) this.items[i] = item; else this.items.push(item);
    this.save();
    return item;
  }

  remove(id: string): Snippet[] {
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
    return this.items;
  }
}
