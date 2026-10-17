/** Type-only。主进程 src/main/forward.ts 的规则/状态形状,渲染层与预加载共用。 */

export type ForwardKind = "local" | "remote" | "dynamic";

export interface ForwardRule {
  id: string;
  hostId: string;
  kind: ForwardKind;
  /** local/dynamic:本机绑定地址(原版默认 0.0.0.0) */
  bindAddress: string;
  /** local/dynamic:本机监听端口 */
  port: number;
  /** local/remote:目的地址与端口 */
  destinationAddress: string;
  destinationPort: number;
  /** remote:远端绑定地址 */
  remoteBindAddress?: string;
  label?: string;
}

export interface ForwardStatus {
  id: string;
  state: "stopped" | "starting" | "running" | "error";
  active: number;
  total: number;
  error?: string;
  boundPort?: number;
}
