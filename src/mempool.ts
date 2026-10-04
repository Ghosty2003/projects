import { txHash, verifyTxSignature } from './crypto.js';
import type { StateMachine } from './state.js';
import type { Transaction } from './types.js';

/** 待打包交易池，键为交易哈希 */
export class Mempool {
  private txs = new Map<string, Transaction>();

  add(tx: Transaction): string {
    if (!verifyTxSignature(tx)) throw new Error('invalid transaction signature');
    const hash = txHash(tx);
    this.txs.set(hash, tx);
    return hash;
  }

  has(hash: string): boolean {
    return this.txs.has(hash);
  }

  remove(hash: string): void {
    this.txs.delete(hash);
  }

  get(hash: string): Transaction | undefined {
    return this.txs.get(hash);
  }

  list(): Transaction[] {
    return [...this.txs.values()];
  }

  get size(): number {
    return this.txs.size;
  }

  /**
   * 按 (发送方, nonce) 顺序在给定状态的副本上模拟执行，
   * 无法执行的交易（nonce 不连续、余额不足、已被主链消费等）一律丢弃。
   */
  revalidate(state: StateMachine): void {
    const sim = state.clone();
    const sorted = this.list().sort((a, b) =>
      a.from === b.from ? a.nonce - b.nonce : a.from < b.from ? -1 : 1,
    );
    const keep = new Map<string, Transaction>();
    for (const tx of sorted) {
      try {
        sim.applyTx(tx);
        keep.set(txHash(tx), tx);
      } catch {
        /* 已失效，丢弃 */
      }
    }
    this.txs = keep;
  }
}
