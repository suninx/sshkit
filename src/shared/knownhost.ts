/** Type-only。T6 主机密钥询问与已知主机列表的形状。 */

export interface HostKeyAsk {
  reqId: string;
  host: string;
  status: "unknown" | "changed";
  keyType: string;
  fingerprint: string;
}

export interface KnownHostRow {
  host: string;
  keyType: string;
  fingerprint: string;
  hashed: boolean;
}
