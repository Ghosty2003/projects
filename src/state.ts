import { buildProof, computeRoot } from './merkle.js';
import type { AccountState, ProofStep, Transaction } from './types.js';

/**
 * 账户状态表。每个区块对应一个不可变快照（通过 clone 派生），
 * 重组时直接切换到目标分叉顶端的状态快照，无需逐块反向回滚。
 */
export class State {
  private accounts = new Map<string, AccountState>();

  static fromAlloc(alloc: Array<{ address: string; balance: number }>): State {
    const s = new State();
    for (const { address, balance } of alloc) {
      if (!Number.isSafeInteger(balance) || balance < 0) throw new Error('invalid genesis balance');
      s.accounts.set(address, { balance, nonce: 0 });
    }
    return s;
  }

  clone(): State {
    const s = new State();
    for (const [addr, acc] of this.accounts) s.accounts.set(addr, { ...acc });
    return s;
  }

  /** 不存在的账户视为 {balance: 0, nonce: 0}。 */
  get(address: string): AccountState {
    const acc = this.accounts.get(address);
    return acc ? { ...acc } : { balance: 0, nonce: 0 };
  }

  /**
   * 应用一笔转账。nonce 必须等于发送方当前 nonce，余额必须充足。
   * 任何检查失败都抛错，且本对象保持不变（调用方在克隆上操作以保证原子性）。
   */
  applyTx(tx: Transaction): void {
    if (!Number.isSafeInteger(tx.amount) || tx.amount <= 0) {
      throw new Error('invalid amount');
    }
    const sender = this.get(tx.from);
    if (tx.nonce !== sender.nonce) {
      throw new Error(`bad nonce for ${tx.from}: expected ${sender.nonce}, got ${tx.nonce}`);
    }
    if (sender.balance < tx.amount) {
      throw new Error(`insufficient balance for ${tx.from}`);
    }
    const receiver = this.get(tx.to);
    this.accounts.set(tx.from, { balance: sender.balance - tx.amount, nonce: sender.nonce + 1 });
    this.accounts.set(tx.to, { balance: receiver.balance + tx.amount, nonce: receiver.nonce });
  }

  /** 按地址升序的账户条目，是状态根与证明的唯一事实来源。 */
  entries(): Array<[string, AccountState]> {
    return [...this.accounts.entries()]
      .map(([addr, acc]): [string, AccountState] => [addr, { ...acc }])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** 状态根：只取决于账户集合内容，与插入顺序无关。 */
  root(): string {
    return computeRoot(this.entries());
  }

  /** 账户的包含证明；账户不存在返回 null。 */
  prove(address: string): { account: AccountState; proof: ProofStep[] } | null {
    const entries = this.entries();
    const account = this.accounts.get(address);
    if (!account) return null;
    const proof = buildProof(entries, address);
    if (!proof) return null;
    return { account: { ...account }, proof };
  }
}
