import { canonical, sha256hex } from './crypto.js';
import { txHash, verifyTx } from './transaction.js';
import type { Block, Transaction } from './types.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** 区块哈希覆盖除 hash 自身外的全部字段（含 stateRoot 与全部交易）。 */
export function computeBlockHash(block: Omit<Block, 'hash'>): string {
  return sha256hex(canonical({
    height: block.height,
    prevHash: block.prevHash,
    timestamp: block.timestamp,
    difficulty: block.difficulty,
    nonce: block.nonce,
    txs: block.txs,
    stateRoot: block.stateRoot,
  }));
}

/** 区块内交易列表的 Merkle 根（当前未写入区块头，供校验与外部使用）。 */
export function txsRoot(txs: Transaction[]): string {
  if (txs.length === 0) return sha256hex('empty-txs');
  let level = txs.map(txHash);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as string;
      const right = (level[i + 1] ?? left) as string;
      next.push(sha256hex('node:' + left + right));
    }
    level = next;
  }
  return level[0] as string;
}

export function isValidBlockShape(b: unknown): b is Block {
  if (typeof b !== 'object' || b === null) return false;
  const r = b as Record<string, unknown>;
  return (
    typeof r.height === 'number' && Number.isSafeInteger(r.height) && r.height >= 0 &&
    typeof r.prevHash === 'string' && HEX64.test(r.prevHash) &&
    typeof r.timestamp === 'number' && Number.isFinite(r.timestamp) &&
    typeof r.difficulty === 'number' && Number.isSafeInteger(r.difficulty) && r.difficulty >= 0 &&
    typeof r.nonce === 'number' && Number.isSafeInteger(r.nonce) && r.nonce >= 0 &&
    Array.isArray(r.txs) &&
    typeof r.stateRoot === 'string' && HEX64.test(r.stateRoot) &&
    typeof r.hash === 'string' && HEX64.test(r.hash)
  );
}

/** 哈希（hex）前 bits 个比特是否全为 0。 */
export function meetsDifficulty(hashHex: string, bits: number): boolean {
  let zeros = 0;
  for (const ch of hashHex) {
    const v = parseInt(ch, 16);
    if (v === 0) {
      zeros += 4;
    } else {
      zeros += v < 2 ? 3 : v < 4 ? 2 : v < 8 ? 1 : 0;
      break;
    }
  }
  return zeros >= bits;
}

/** 暴力寻找满足难度的 nonce，返回带正确 hash 的区块。 */
export function sealBlock(block: Block): Block {
  for (let nonce = 0; ; nonce++) {
    const candidate: Block = { ...block, nonce };
    const hash = computeBlockHash(candidate);
    if (meetsDifficulty(hash, block.difficulty)) {
      return { ...candidate, hash };
    }
  }
}

/** 校验区块内所有交易签名（状态无关部分）。 */
export function allTxsValid(txs: unknown[]): txs is Transaction[] {
  return txs.every((tx) => verifyTx(tx));
}
