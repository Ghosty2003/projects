/** 共享类型定义。所有金额与 nonce 均为非负安全整数。 */

export interface Transaction {
  /** 发送方地址（= 公钥哈希的 hex） */
  from: string;
  to: string;
  amount: number;
  /** 发送方账户序号，从 0 开始逐笔递增 */
  nonce: number;
  /** 发送方 ed25519 公钥（spki DER 的 hex） */
  publicKey: string;
  /** 对 canonical({from,to,amount,nonce}) 的 ed25519 签名（hex） */
  signature: string;
}

export interface Block {
  height: number;
  prevHash: string;
  timestamp: number;
  /** 难度：要求区块哈希前 difficulty 个比特为 0 */
  difficulty: number;
  /** PoW 随机数 */
  nonce: number;
  txs: Transaction[];
  /** 应用本块全部交易后的状态根 */
  stateRoot: string;
  hash: string;
}

export interface AccountState {
  balance: number;
  nonce: number;
}

export interface ProofStep {
  /** 兄弟节点相对当前节点的位置 */
  position: 'left' | 'right';
  hash: string;
}

export interface InclusionProof {
  root: string;
  address: string;
  account: AccountState;
  proof: ProofStep[];
}
