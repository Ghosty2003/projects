import { canonical, sha256hex } from './crypto.js';
import type { AccountState, ProofStep } from './types.js';

/**
 * 账户状态 Merkle 树。
 * 叶子按地址字典序排列，因此根与账户插入顺序无关。
 * 叶子哈希带 'leaf:' 前缀、内部节点带 'node:' 前缀，防止第二原像攻击。
 */

export function leafHash(address: string, account: AccountState): string {
  return sha256hex('leaf:' + canonical([address, account.balance, account.nonce]));
}

function nodeHash(left: string, right: string): string {
  return sha256hex('node:' + left + right);
}

export const EMPTY_ROOT = sha256hex('empty-state');

/** entries 必须已按地址升序排列。 */
export function computeRoot(entries: Array<[string, AccountState]>): string {
  if (entries.length === 0) return EMPTY_ROOT;
  let level = entries.map(([addr, acc]) => leafHash(addr, acc));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as string;
      const right = (level[i + 1] ?? left) as string;
      next.push(nodeHash(left, right));
    }
    level = next;
  }
  return level[0] as string;
}

/** 为 entries（已排序）中指定地址生成包含证明；地址不存在时返回 null。 */
export function buildProof(
  entries: Array<[string, AccountState]>,
  address: string,
): ProofStep[] | null {
  const index = entries.findIndex(([addr]) => addr === address);
  if (index < 0) return null;
  const proof: ProofStep[] = [];
  let level = entries.map(([addr, acc]) => leafHash(addr, acc));
  let i = index;
  while (level.length > 1) {
    const siblingIndex = i % 2 === 0 ? i + 1 : i - 1;
    const sibling = level[siblingIndex] ?? (level[i] as string); // 奇数个节点时复制自身
    proof.push({ position: i % 2 === 0 ? 'right' : 'left', hash: sibling });
    const next: string[] = [];
    for (let j = 0; j < level.length; j += 2) {
      const left = level[j] as string;
      const right = (level[j + 1] ?? left) as string;
      next.push(nodeHash(left, right));
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

/** 独立校验：不依赖节点状态，纯函数。 */
export function verifyProof(
  root: string,
  address: string,
  account: AccountState,
  proof: ProofStep[],
): boolean {
  if (typeof root !== 'string' || !/^[0-9a-f]{64}$/.test(root)) return false;
  if (!Number.isSafeInteger(account.balance) || account.balance < 0) return false;
  if (!Number.isSafeInteger(account.nonce) || account.nonce < 0) return false;
  let cur = leafHash(address, account);
  for (const step of proof) {
    if (typeof step.hash !== 'string' || !/^[0-9a-f]{64}$/.test(step.hash)) return false;
    cur = step.position === 'left' ? nodeHash(step.hash, cur) : nodeHash(cur, step.hash);
  }
  return cur === root;
}
