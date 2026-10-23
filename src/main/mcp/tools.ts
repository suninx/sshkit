/* MCP v1 的四个只读工具。
   工具描述按 IDEA 2026 的 MCP 约定来写:动词开头、参数说明具体、
   输出有上限且可续读(这里先用"截断+总长度"提示,分页留到阶段 4)。 */

import type { McpToolDef } from "../../shared/mcp";
import type { McpTool } from "./server";
import type { RemoteEntry } from "./remote";

export interface McpHostInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: string;
}

/** 工具真正需要的远端能力(主进程注入;单测里换成假实现) */
export interface McpRemoteOps {
  list(hostId: string, dir: string): Promise<RemoteEntry[]>;
  read(hostId: string, file: string, maxBytes: number): Promise<{ text: string; truncated: boolean; size: number; binary: boolean }>;
  stat(hostId: string, path: string): Promise<RemoteEntry>;
  /* ---- 阶段 2:写入/传输 ---- */
  mkdir(hostId: string, path: string): Promise<void>;
  rename(hostId: string, from: string, to: string): Promise<void>;
  remove(hostId: string, target: string): Promise<void>;
  chmod(hostId: string, target: string, mode: number): Promise<void>;
  write(hostId: string, target: string, content: Buffer): Promise<number>;
  upload(hostId: string, localPath: string, remotePath: string): Promise<{ bytes: number }>;
  download(hostId: string, remotePath: string, localPath: string): Promise<{ bytes: number }>;
}


export interface McpToolDeps {
  listHosts(): McpHostInfo[];
  findHost(idOrName: string): McpHostInfo | undefined;
  remote: McpRemoteOps;
}

const MAX_READ_BYTES = 128 * 1024;      // 单次读 128KB(够看配置/日志;再大让模型自己 offset 读)
const MAX_LIST_ENTRIES = 500;           // 目录条目上限
const MAX_OUTPUT_CHARS = 24_000;        // 单条工具输出上限(约 6k token)

const clipOut = (text: string): string =>
  text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(输出被截断,原始长度 ${text.length} 字符)`;

/** 列表类输出:超长时**少放几条**而不是把 JSON 砍断(模型解析不了半截 JSON) */
export function capList(payload: Record<string, unknown>, key: string, items: unknown[]): string {
  let n = items.length;
  let out = JSON.stringify({ ...payload, [key]: items, truncatedAt: null }, null, 2);
  while (out.length > MAX_OUTPUT_CHARS && n > 0) {
    n = Math.max(0, Math.floor(n * 0.8));
    out = JSON.stringify({ ...payload, [key]: items.slice(0, n), truncatedAt: n }, null, 2);
  }
  return out;
}

const HOST_ARG = {
  type: "string",
  description: "Host id (from list_hosts) or the host name shown in sshkit. Credentials stay local — never pass a password.",
};

/** 解析主机:先按 id,再按名字;都找不到时给出可用清单,方便模型自我纠正 */
export function resolveHost(deps: McpToolDeps, idOrName: string): McpHostInfo {
  const hit = deps.findHost(idOrName);
  if (hit) return hit;
  const avail = deps.listHosts().map((h) => `${h.id} (${h.name})`).join(", ") || "(none)";
  throw new Error(`unknown host: "${idOrName}". Available hosts: ${avail}. Call list_hosts to see details.`);
}

const defs: Record<string, Omit<McpToolDef, "name">> = {
  list_hosts: {
    title: "List hosts",
    description: "List the hosts saved in sshkit (id, name, address, user, auth type). "
      + "Use this first to find the host id to pass to other tools. Secret values are never returned.",
    kind: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  sftp_list: {
    title: "List remote directory",
    description: "List a directory on a remote host over SFTP. Returns name, type (dir/file/other), size, mtime and permissions. "
      + "Results are capped at 500 entries and sorted with directories first.",
    kind: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: HOST_ARG,
        path: { type: "string", description: "Absolute remote directory path, e.g. /var/www/html" },
      },
      required: ["host", "path"],
      additionalProperties: false,
    },
  },
  sftp_read_file: {
    title: "Read remote file",
    description: "Read a remote file over SFTP. Text files are returned as UTF-8 (max 128 KiB per call, "
      + "truncation is reported). Binary files are reported instead of returning mojibake.",
    kind: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: HOST_ARG,
        path: { type: "string", description: "Absolute remote file path" },
        maxBytes: { type: "integer", description: "Read at most this many bytes (default 131072, max 131072)" },
      },
      required: ["host", "path"],
      additionalProperties: false,
    },
  },
  sftp_stat: {
    title: "Stat remote path",
    description: "Return metadata for a remote path over SFTP: type, size, mtime, octal mode and permission string.",
    kind: "read",
    inputSchema: {
      type: "object",
      properties: {
        host: HOST_ARG,
        path: { type: "string", description: "Absolute remote path" },
      },
      required: ["host", "path"],
      additionalProperties: false,
    },
  },
};

const argString = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`parameter "${key}" must be a non-empty string`);
  return v.trim();
};

export function buildReadTools(deps: McpToolDeps): McpTool[] {
  return [
    {
      def: { name: "list_hosts", ...defs.list_hosts },
      async run() {
        const hosts = deps.listHosts().map((h) => ({
          id: h.id, name: h.name, address: `${h.host}:${h.port}`, username: h.username, authType: h.authType,
        }));
        return { text: clipOut(JSON.stringify({ hosts, count: hosts.length }, null, 2)) };
      },
    },
    {
      def: { name: "sftp_list", ...defs.sftp_list },
      async run(args) {
        const host = resolveHost(deps, argString(args, "host"));
        const dir = argString(args, "path");
        const entries = await deps.remote.list(host.id, dir);
        const shown = entries.slice(0, MAX_LIST_ENTRIES);
        return {
          text: capList({
            host: `${host.name} (${host.host})`, path: dir, count: entries.length,
            truncated: entries.length > shown.length,
          }, "entries", shown),
        };
      },
    },
    {
      def: { name: "sftp_read_file", ...defs.sftp_read_file },
      async run(args) {
        const host = resolveHost(deps, argString(args, "host"));
        const file = argString(args, "path");
        const asked = typeof args.maxBytes === "number" && Number.isFinite(args.maxBytes) ? args.maxBytes : MAX_READ_BYTES;
        const want = Math.max(1, Math.min(MAX_READ_BYTES, Math.floor(asked)));
        const res = await deps.remote.read(host.id, file, want);
        if (res.binary) {
          return { text: `[binary file] ${file} — ${res.size} bytes; not returned as text. Use sftp_stat or download it instead.`, isError: true };
        }
        return { text: clipOut(`# ${host.name}:${file} (${res.size} bytes${res.truncated ? `, first ${want} shown` : ""})\n\n${res.text}`) };
      },
    },
    {
      def: { name: "sftp_stat", ...defs.sftp_stat },
      async run(args) {
        const host = resolveHost(deps, argString(args, "host"));
        const target = argString(args, "path");
        const st = await deps.remote.stat(host.id, target);
        return { text: clipOut(JSON.stringify({ host: `${host.name} (${host.host})`, path: target, ...st }, null, 2)) };
      },
    },
  ];
}

/* ================= 阶段 2:写入工具 ================= */

const WRITE_DEFS: Record<string, Omit<McpToolDef, "name">> = {
  sftp_mkdir: {
    title: "Create remote directory",
    description: "Create one directory on the remote host over SFTP (parent must exist). "
      + "Uses the same semantics as the sshkit UI button 'New folder'.",
    kind: "write",
    inputSchema: {
      type: "object",
      properties: { host: HOST_ARG, path: { type: "string", description: "Absolute remote directory path to create" } },
      required: ["host", "path"], additionalProperties: false,
    },
  },
  sftp_rename: {
    title: "Rename or move remote path",
    description: "Rename/move a remote file or directory (SFTP rename; target must not exist).",
    kind: "write",
    inputSchema: {
      type: "object",
      properties: {
        host: HOST_ARG,
        from: { type: "string", description: "Absolute remote source path" },
        to: { type: "string", description: "Absolute remote destination path" },
      },
      required: ["host", "from", "to"], additionalProperties: false,
    },
  },
  sftp_remove: {
    title: "Remove remote path",
    description: "Remove a remote file (unlink) or an EMPTY directory (rmdir). "
      + "Non-empty directories fail — list and remove children first, deliberately.",
    kind: "write",
    inputSchema: {
      type: "object",
      properties: { host: HOST_ARG, path: { type: "string", description: "Absolute remote path to remove" } },
      required: ["host", "path"], additionalProperties: false,
    },
  },
  sftp_chmod: {
    title: "Change remote permissions",
    description: "Change permissions of a remote path. Pass an octal mode string like \"644\" or \"0755\".",
    kind: "write",
    inputSchema: {
      type: "object",
      properties: {
        host: HOST_ARG,
        path: { type: "string", description: "Absolute remote path" },
        mode: { type: "string", description: "Octal permission bits, e.g. \"644\" / \"0600\" / \"755\"" },
      },
      required: ["host", "path", "mode"], additionalProperties: false,
    },
  },
  sftp_write_file: {
    title: "Write remote file",
    description: "Create or overwrite a remote text file over SFTP with the given UTF-8 content. "
      + "Returns the number of bytes written. Use sftp_read_file first if you need to preserve existing content.",
    kind: "write",
    inputSchema: {
      type: "object",
      properties: {
        host: HOST_ARG,
        path: { type: "string", description: "Absolute remote file path" },
        content: { type: "string", description: "UTF-8 text content to write (overwrites the file)" },
      },
      required: ["host", "path", "content"], additionalProperties: false,
    },
  },
  sftp_upload: {
    title: "Upload local file",
    description: "Upload one file from the machine running sshkit to the remote host (streaming). "
      + "The local path is on the sshkit side, not the remote side.",
    kind: "write",
    inputSchema: {
      type: "object",
      properties: {
        host: HOST_ARG,
        localPath: { type: "string", description: "Absolute local path (on the machine running sshkit)" },
        remotePath: { type: "string", description: "Absolute remote destination path (overwrites)" },
      },
      required: ["host", "localPath", "remotePath"], additionalProperties: false,
    },
  },
  sftp_download: {
    title: "Download remote file",
    description: "Download one remote file to the machine running sshkit (streaming, overwrites the local target).",
    kind: "write",
    inputSchema: {
      type: "object",
      properties: {
        host: HOST_ARG,
        remotePath: { type: "string", description: "Absolute remote source path" },
        localPath: { type: "string", description: "Absolute local destination path (on the machine running sshkit)" },
      },
      required: ["host", "remotePath", "localPath"], additionalProperties: false,
    },
  },
};

/** 八进制权限串解析("644" / "0644" / "0755"),非法值直接报错 */
export function parseMode(raw: string): number {
  const s = raw.trim();
  if (!/^[0-7]{3,4}$/.test(s)) throw new Error(`invalid permission mode "${raw}" (expected octal like 644 or 0755)`);
  return parseInt(s, 8);
}

export function buildWriteTools(deps: McpToolDeps): McpTool[] {
  return [
    {
      def: { name: "sftp_mkdir", ...WRITE_DEFS.sftp_mkdir },
      async run(args) {
        const host = resolveHost(deps, argString(args, "host"));
        const path = argString(args, "path");
        await deps.remote.mkdir(host.id, path);
        return { text: `created directory ${host.name}:${path}` };
      },
    },
    {
      def: { name: "sftp_rename", ...WRITE_DEFS.sftp_rename },
      async run(args) {
        const host = resolveHost(deps, argString(args, "host"));
        const from = argString(args, "from");
        const to = argString(args, "to");
        await deps.remote.rename(host.id, from, to);
        return { text: `renamed ${host.name}:${from} → ${to}` };
      },
    },
    {
      def: { name: "sftp_remove", ...WRITE_DEFS.sftp_remove },
      async run(args) {
        const host = resolveHost(deps, argString(args, "host"));
        const path = argString(args, "path");
        await deps.remote.remove(host.id, path);
        return { text: `removed ${host.name}:${path}` };
      },
    },
    {
      def: { name: "sftp_chmod", ...WRITE_DEFS.sftp_chmod },
      async run(args) {
        const host = resolveHost(deps, argString(args, "host"));
        const path = argString(args, "path");
        const mode = parseMode(argString(args, "mode"));
        await deps.remote.chmod(host.id, path, mode);
        return { text: `chmod ${mode.toString(8)} ${host.name}:${path}` };
      },
    },
    {
      def: { name: "sftp_write_file", ...WRITE_DEFS.sftp_write_file },
      async run(args) {
        const host = resolveHost(deps, argString(args, "host"));
        const path = argString(args, "path");
        const content = typeof args.content === "string" ? args.content : null;
        if (content === null) throw new Error('parameter "content" must be a string');
        const bytes = await deps.remote.write(host.id, path, Buffer.from(content, "utf-8"));
        return { text: `wrote ${bytes} bytes to ${host.name}:${path}` };
      },
    },
    {
      def: { name: "sftp_upload", ...WRITE_DEFS.sftp_upload },
      async run(args) {
        const host = resolveHost(deps, argString(args, "host"));
        const localPath = argString(args, "localPath");
        const remotePath = argString(args, "remotePath");
        const { bytes } = await deps.remote.upload(host.id, localPath, remotePath);
        return { text: `uploaded ${bytes} bytes: ${localPath} → ${host.name}:${remotePath}` };
      },
    },
    {
      def: { name: "sftp_download", ...WRITE_DEFS.sftp_download },
      async run(args) {
        const host = resolveHost(deps, argString(args, "host"));
        const remotePath = argString(args, "remotePath");
        const localPath = argString(args, "localPath");
        const { bytes } = await deps.remote.download(host.id, remotePath, localPath);
        return { text: `downloaded ${bytes} bytes: ${host.name}:${remotePath} → ${localPath}` };
      },
    },
  ];
}
