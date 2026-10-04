export interface Transaction {
  /** 发送方地址 = sha256(publicKey) */
  from: string;
  /** 接收方地址 */
  to: string;
  /** 转账金额（正整数） */
  amount: number;
  /** 发送方账户序号，必须连续 */
  nonce: number;
  /** 发送方公钥（DER hex） */
  publicKey: string;
  /** 对 {from,to,amount,nonce} 规范化 JSON 的 ed25519 签名（hex） */
  signature: string;
}

export interface Block {
  height: number;
  prevHash: string;
  timestamp: number;
  /** 难度：区块哈希需以该数量的十六进制 0 开头 */
  difficulty: number;
  powNonce: number;
  /** 执行完本块交易后的状态根 */
  stateRoot: string;
  /** 交易列表的默克尔根 */
  txRoot: string;
  txs: Transaction[];
  hash: string;
}

export interface AccountState {
  balance: number;
  nonce: number;
}
