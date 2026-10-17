/** Shared between main / preload / renderer. Type-only module. */

export type AuthType = "password" | "key" | "agent";

export interface HostRecord {
  id: string;
  name: string;
  group?: string;
  /** T7:标签。原版侧栏工具栏有 `Filter by tags`,可对主机打标签并按标签过滤(见 F26)。 */
  tags?: string[];
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  /** absolute or ~-relative path; required when authType === "key" */
  keyPath?: string;
  createdAt: string;
}

export type HostInput = Omit<HostRecord, "id" | "createdAt">;

export interface ConnectResult {
  id: number;
}

export interface ExitInfo {
  exitCode: number;
  error?: string;
}
