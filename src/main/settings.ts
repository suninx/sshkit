/* 应用级设置(目前只有语言)。放在 userData 下的 settings.json,
   让主进程与渲染进程读同一份 —— 语言不能只存在 localStorage,
   否则主进程的提示语仍会是另一套语言。 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { LocalePref } from "../shared/i18n";
import { MCP_DEFAULT_PORT, type McpSettings } from "../shared/mcp";

export interface Settings {
  /** "system" 跟随系统;否则强制 zh / en */
  locale: LocalePref;
  /** 内置 MCP 服务器(默认关闭;端口只绑 127.0.0.1) */
  mcp: McpSettings;
}

const DEFAULTS: Settings = { locale: "system", mcp: { enabled: false, port: MCP_DEFAULT_PORT, policy: "full" } };

let cache: Settings | null = null;

const file = (): string => path.join(app.getPath("userData"), "settings.json");

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf-8")) as Partial<Settings>;
    /* mcp 是嵌套对象:浅合并会把旧文件里缺失的字段吃掉,单独合一层 */
    cache = { ...DEFAULTS, ...raw, mcp: { ...DEFAULTS.mcp, ...(raw.mcp ?? {}) } };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Settings {
  const next = { ...getSettings(), [key]: value };
  cache = next;
  try {
    const dir = path.dirname(file());
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file());
  } catch (err) {
    console.error("[settings] 写入失败:", err);
  }
  return next;
}
