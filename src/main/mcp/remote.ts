/* 远端 SFTP 原语(供 MCP 工具用)。
   与 SftpController 的区别:控制器按**会话 id** 取 SFTP 连接(它服务界面上的两个栏),
   而 MCP 面对的是"主机 id" —— 客户端没有终端会话。所以这里用
   「主机 id → 独立 SFTP 连接」的池子,并把三个只读原语做成可注入的小函数,
   方便用假实现做单测(与 sftp-tree 测试同一思路)。 */

export interface RemoteEntry {
  name: string;
  type: "dir" | "file" | "other";
  size: number;
  /** epoch 秒(与 SFTP attrs.mtime 一致) */
  mtime: number;
  /** 完整 mode 位(含类型位),例子:0o100644 */
  mode: number;
  /** 人类可读权限串,例子:-rw-r--r-- */
  perm: string;
}

export interface SftpAttrs {
  mode: number;
  size: number;
  mtime: number;
  isDirectory?: () => boolean;
  isFile?: () => boolean;
}

export interface SftpDirEntry { filename: string; attrs: SftpAttrs }

/** 只依赖用得到的四个方法,测试里给个假对象即可 */
export interface SftpLike {
  readdir(path: string, cb: (err: Error | null | undefined, list: SftpDirEntry[]) => void): void;
  stat(path: string, cb: (err: Error | null | undefined, attrs: SftpAttrs) => void): void;
  createReadStream(path: string, opts?: { start?: number; end?: number }): NodeJS.ReadableStream;
}

/* 只判断"非目录":目录由 toEntry 里 isDirectory()/类型位单独识别 */
const kindOf = (mode: number): RemoteEntry["type"] => {
  const kind = mode & 0o170000;          // 只看类型位(0644 这类权限位不能参与比较)
  return kind === 0o100000 || kind === 0 ? "file" : "other";
};

/** 与列表里显示一致的权限串(drwxr-xr-x / -rw-r--r--) */
export function permString(mode: number): string {
  const rwx = (bits: number): string =>
    `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
  const kind = mode & 0o170000;
  const head = kind === 0o040000 ? "d" : kind === 0o100000 || kind === 0 ? "-" : "?";
  return `${head}${rwx((mode >> 6) & 7)}${rwx((mode >> 3) & 7)}${rwx(mode & 7)}`;
}

const toEntry = (name: string, attrs: SftpAttrs): RemoteEntry => {
  /* 有些 SFTP 服务端不给 isDirectory(),就按 mode 判(与 sftp.ts 里的规则一致) */
  const isDir = attrs.isDirectory ? attrs.isDirectory() : (attrs.mode & 0o170000) === 0o040000;
  const type = isDir ? "dir" : kindOf(attrs.mode);
  return { name, type, size: attrs.size, mtime: attrs.mtime, mode: attrs.mode, perm: permString(attrs.mode) };
};

export function listRemote(sftp: SftpLike, dir: string): Promise<RemoteEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => {
      if (err) { reject(err); return; }
      resolve(list
        .map((e) => toEntry(e.filename, e.attrs))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : b.type === "dir" ? 1 : 0)));
    });
  });
}

export function statRemote(sftp: SftpLike, target: string): Promise<RemoteEntry> {
  return new Promise((resolve, reject) => {
    sftp.stat(target, (err, attrs) => {
      if (err) { reject(err); return; }
      const name = target.replace(/\/+$/, "").split("/").pop() || "/";
      resolve(toEntry(name, attrs));
    });
  });
}

export interface ReadResult {
  text: string;
  /** 是否因为超过上限被截断 */
  truncated: boolean;
  size: number;
  /** 内容里出现 NUL 或非法 UTF-8 就按二进制处理,不给模型喂乱码 */
  binary: boolean;
}

/** 读远端文件(最多 maxBytes)。二进制文件返回说明而不是乱码 */
export function readRemote(sftp: SftpLike, file: string, maxBytes: number): Promise<ReadResult> {
  return new Promise((resolve, reject) => {
    sftp.stat(file, (err, attrs) => {
      if (err) { reject(err); return; }
      const size = attrs.size;
      const chunks: Buffer[] = [];
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        const buf = Buffer.concat(chunks);
        const binary = buf.includes(0);
        resolve({
          text: binary ? "" : buf.toString("utf-8"),
          truncated: size > maxBytes,
          size,
          binary,
        });
      };
      /* 读取范围由 end 界定(服务端不会给超),所以不需要额外的"超量保护"分支 */
      const stream = sftp.createReadStream(file, { start: 0, end: Math.max(0, Math.min(size, maxBytes) - 1) });
      stream.on("data", (c: Buffer) => { chunks.push(c); });
      /* resolve 之后再 reject 是 no-op;error 之后 end/close 也不会重复结算(done 标记在 finish 里) */
      stream.on("error", (e: Error) => { reject(e); });
      stream.on("end", finish);
      stream.on("close", finish);
    });
  });
}
