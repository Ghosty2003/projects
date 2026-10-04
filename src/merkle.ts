import { canonical, sha256hex } from './crypto.js';
import type { AccountState } from './types.js';

export interface ProofStep {
  hash: string;
  /** 兄弟节点在左还是右 */
  position: 'left' | 'right';
}

function pairHash(a: string, b: string): string {
  return sha256hex(a + b);
}

/** 通用默克尔根；奇数个节点时复制最后一个。空列表返回 sha256('')。 */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256hex('');
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left;
      next.push(pairHash(left, right));
    }
    level = next;
  }
  return level[0]!;
}

export function merkleProof(leaves: string[], index: number): ProofStep[] {
  const proof: ProofStep[] = [];
  let level = leaves.slice();
  let idx = index;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left;
      if (i === idx) proof.push({ hash: right, position: 'right' });
      else if (i + 1 === idx) proof.push({ hash: left, position: 'left' });
      next.push(pairHash(left, right));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

export function verifyMerkleProof(root: string, leaf: string, proof: ProofStep[]): boolean {
  let hash = leaf;
  for (const step of proof) {
    if (typeof step.hash !== 'string' || (step.position !== 'left' && step.position !== 'right')) return false;
    hash = step.position === 'left' ? pairHash(step.hash, hash) : pairHash(hash, step.hash);
  }
  return hash === root;
}

export function accountLeaf(address: string, account: AccountState): string {
  return sha256hex(canonical({ address, balance: account.balance, nonce: account.nonce }));
}

/** 叶子按地址字典序排列 —— 状态根与账户插入顺序无关 */
export function stateLeaves(accounts: Map<string, AccountState>): { addresses: string[]; leaves: string[] } {
  const addresses = [...accounts.keys()].sort();
  return { addresses, leaves: addresses.map((a) => accountLeaf(a, accounts.get(a)!)) };
}

export function computeStateRoot(accounts: Map<string, AccountState>): string {
  return merkleRoot(stateLeaves(accounts).leaves);
}

/** 独立校验：给定状态根、地址、账户内容与证明路径，验证包含性 */
export function verifyStateProof(
  root: string,
  address: string,
  account: AccountState,
  proof: ProofStep[],
): boolean {
  if (typeof address !== 'string' || !Array.isArray(proof)) return false;
  if (!Number.isInteger(account?.balance) || !Number.isInteger(account?.nonce)) return false;
  return verifyMerkleProof(root, accountLeaf(address, account), proof);
}
