import { verifyTxSignature } from './crypto.js';
import { computeStateRoot, merkleProof, stateLeaves, type ProofStep } from './merkle.js';
import type { AccountState, Transaction } from './types.js';

export interface StateProof {
  root: string;
  account: AccountState | null;
  proof: ProofStep[];
}

/**
 * 账户状态机：余额 + nonce。
 * applyTx 校验签名、nonce 连续、余额充足，任一失败抛错且不修改本实例。
 */
export class StateMachine {
  private readonly accounts = new Map<string, AccountState>();

  static fromAlloc(alloc: Record<string, number>): StateMachine {
    const s = new StateMachine();
    for (const [address, balance] of Object.entries(alloc)) {
      if (!Number.isInteger(balance) || balance < 0) throw new Error(`invalid alloc for ${address}`);
      s.accounts.set(address, { balance, nonce: 0 });
    }
    return s;
  }

  clone(): StateMachine {
    const s = new StateMachine();
    for (const [k, v] of this.accounts) s.accounts.set(k, { ...v });
    return s;
  }

  get(address: string): AccountState {
    return this.accounts.get(address) ?? { balance: 0, nonce: 0 };
  }

  entries(): [string, AccountState][] {
    return [...this.accounts.entries()].map(([k, v]) => [k, { ...v }]);
  }

  /** 非破坏性检查：交易能否按序应用到当前状态 */
  canApply(tx: Transaction): boolean {
    try {
      this.clone().applyTx(tx);
      return true;
    } catch {
      return false;
    }
  }

  applyTx(tx: Transaction): void {
    if (typeof tx.from !== 'string' || typeof tx.to !== 'string' || tx.to.length === 0) {
      throw new Error('bad addresses');
    }
    if (!Number.isInteger(tx.amount) || tx.amount <= 0) throw new Error('bad amount');
    if (!Number.isInteger(tx.nonce) || tx.nonce < 0) throw new Error('bad nonce');
    if (!verifyTxSignature(tx)) throw new Error('bad signature');
    const sender = this.get(tx.from);
    if (tx.nonce !== sender.nonce) {
      throw new Error(`nonce mismatch: expected ${sender.nonce}, got ${tx.nonce}`);
    }
    if (sender.balance < tx.amount) throw new Error('insufficient balance');
    this.accounts.set(tx.from, { balance: sender.balance - tx.amount, nonce: sender.nonce + 1 });
    const recv = this.get(tx.to);
    this.accounts.set(tx.to, { balance: recv.balance + tx.amount, nonce: recv.nonce });
  }

  applyBlock(txs: Transaction[]): void {
    for (const tx of txs) this.applyTx(tx);
  }

  root(): string {
    return computeStateRoot(this.accounts);
  }

  proof(address: string): StateProof {
    const { addresses, leaves } = stateLeaves(this.accounts);
    const idx = addresses.indexOf(address);
    if (idx === -1) return { root: this.root(), account: null, proof: [] };
    return { root: this.root(), account: this.get(address), proof: merkleProof(leaves, idx) };
  }
}
