/** Type-only. Shared entry shape for local fs and SFTP listings. */
export interface SftpEntry {
  name: string;
  size: number;
  isDir: boolean;
  mtime: number;
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
  state: "active" | "done" | "error";
  error?: string;
}
