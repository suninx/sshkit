/** Type-only. Shared entry shape for local fs and SFTP listings. */
export interface SftpEntry {
  name: string;
  size: number;
  isDir: boolean;
  mtime: number;
  /** 原始 st_mode 位。原版 SFTP 行内会显示 `drwxr-xr-x` 这样的权限串(T5 复刻需要) */
  mode: number;
}

export interface DirListing {
  path: string;
  entries: SftpEntry[];
}

export interface TransferProgress {
  sid: number;
  jobId: number;
  /** "up" local→remote, "down" remote→local */
  dir: "up" | "down";
  file: string;
  bytes: number;
  total: number;
  state: "active" | "done" | "error" | "cancelled";
  error?: string;
}

/** 树(目录)传输:在单文件进度之上叠加"第几个文件 / 整体字节",渲染层据此画队列 */
export interface TreeProgress extends TransferProgress {
  /** 树内相对路径(posix 风格,不含根名) */
  relPath: string;
  /** 第几个文件,1 基 */
  index: number;
  count: number;
  overallBytes: number;
  overallTotal: number;
}

export interface TreeResult {
  jobId: number;
  files: number;
  bytes: number;
  cancelled: boolean;
}
