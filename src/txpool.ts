import { verifyTx, txHash } from './transaction.js';
import type { State } from './state.js';
import type { Transaction } from './types.js';

/**
 * 交易池。只接受签名有效、nonce 与链上状态连续（允许排队）、
 * 且累计花费不超过余额的交易。重组后由 Chain 负责回流与清理。
 */
export class TxPool {
  private txs = new Map<string, Transaction>();

  get size(): number {
    return this.txs.size;
  }

  has(hash: string): boolean {
    return this.txs.has(hash);
  }

  remove(hash: string): void {
    this.txs.delete(hash);
  }

  list(): Transaction[] {
    return [...this.txs.values()];
  }

  /** 某发送方在池中的交易，按 nonce 升序。 */
  pendingOf(from: string): Transaction[] {
    return this.list()
      .filter((tx) => tx.from === from)
      .sort((a, b) => a.nonce - b.nonce);
  }

  /** 校验并加入交易池；不合法时抛错，池保持不变。 */
  add(tx: Transaction, state: State): void {
    if (!verifyTx(tx)) throw new Error('invalid transaction signature or shape');
    const hash = txHash(tx);
    if (this.txs.has(hash)) throw new Error('duplicate transaction');
    const onChain = state.get(tx.from);
    if (tx.nonce < onChain.nonce) {
      throw new Error(`nonce already consumed on chain (have ${onChain.nonce}, got ${tx.nonce})`);
    }
    const pending = this.pendingOf(tx.from);
    if (pending.some((p) => p.nonce === tx.nonce)) {
      throw new Error(`nonce ${tx.nonce} already pending for ${tx.from}`);
    }
    // 只允许紧贴链上 nonce + 已排队交易追加，防止出现空洞
    const expected = onChain.nonce + pending.length;
    if (tx.nonce !== expected) {
      throw new Error(`nonce gap: expected ${expected}, got ${tx.nonce}`);
    }
    const spent = pending.reduce((sum, p) => sum + p.amount, 0);
    if (spent + tx.amount > onChain.balance) {
      throw new Error('insufficient balance including pending transactions');
    }
    this.txs.set(hash, tx);
  }

  /** 按发送方分组（地址升序），组内按 nonce 升序。 */
  private bySender(): Array<[string, Transaction[]]> {
    const groups = new Map<string, Transaction[]>();
    for (const tx of this.txs.values()) {
      const list = groups.get(tx.from);
      if (list) list.push(tx);
      else groups.set(tx.from, [tx]);
    }
    return [...groups.entries()]
      .map(([from, list]): [string, Transaction[]] => [from, list.sort((a, b) => a.nonce - b.nonce)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** 从池中选出可立即按序上链的交易（在 state 的克隆上模拟执行）。 */
  pickForBlock(state: State, max: number): Transaction[] {
    const sim = state.clone();
    const result: Transaction[] = [];
    for (const [, list] of this.bySender()) {
      for (const tx of list) {
        if (result.length >= max) return result;
        try {
          sim.applyTx(tx);
          result.push(tx);
        } catch {
          // 余额不足等：跳过该交易；同发送方后续 nonce 不连续也会被跳过
        }
      }
    }
    return result;
  }

  /**
   * 依据最新链上状态清理池中失效交易：
   * nonce 已被消费、出现空洞、或累计花费超过余额的交易全部丢弃。
   */
  pruneInvalid(state: State): void {
    for (const [, list] of this.bySender()) {
      let nonce = state.get(list[0]!.from).nonce;
      let balance = state.get(list[0]!.from).balance;
      for (const tx of list) {
        if (tx.nonce !== nonce || tx.amount > balance) {
          this.txs.delete(txHash(tx));
          continue;
        }
        nonce += 1;
        balance -= tx.amount;
      }
    }
  }
}
