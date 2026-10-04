import { txHash, verifyTxSignature } from './crypto.js';
import { Chain, computeTxRoot, sealBlock } from './chain.js';
import { Mempool } from './mempool.js';
import type { StateMachine } from './state.js';
import type { StateProof } from './state.js';
import type { Block, Transaction } from './types.js';

export interface NodeOptions {
  /** 创世分配：地址 -> 初始余额 */
  alloc?: Record<string, number>;
  /** 最低难度（十六进制前导零个数），默认 2 */
  difficulty?: number;
}

export interface SubmitResult {
  reorged: boolean;
  tip: string;
  height: number;
}

export class Node {
  readonly chain: Chain;
  readonly mempool = new Mempool();

  constructor(options: NodeOptions = {}) {
    this.chain = new Chain(options.alloc ?? {}, options.difficulty ?? 2);
  }

  private tipState(): StateMachine {
    return this.chain.stateAt(this.chain.tip.hash)!;
  }

  /** 提交交易到交易池：校验签名与 nonce 下限 */
  submitTx(tx: Transaction): string {
    if (!verifyTxSignature(tx)) throw new Error('invalid transaction signature');
    const state = this.tipState();
    if (tx.nonce < state.get(tx.from).nonce) throw new Error('nonce too low');
    return this.mempool.add(tx);
  }

  /**
   * 组装并挖矿一个区块。默认基于主链顶端，从交易池选取可执行交易；
   * 也可指定父块哈希与交易列表（用于构造分叉）。
   */
  buildBlock(prevHash?: string, txs?: Transaction[]): Block {
    const parentHash = prevHash ?? this.chain.tip.hash;
    const parent = this.chain.get(parentHash);
    if (!parent) throw new Error('unknown parent');
    const state = this.chain.stateAt(parentHash)!;
    const source = txs ?? this.mempool.list();
    const sorted = [...source].sort((a, b) =>
      a.from === b.from ? a.nonce - b.nonce : a.from < b.from ? -1 : 1,
    );
    const selected: Transaction[] = [];
    for (const tx of sorted) {
      try {
        state.applyTx(tx);
        selected.push(tx);
      } catch {
        /* 跳过无法执行的交易 */
      }
    }
    return sealBlock({
      height: parent.height + 1,
      prevHash: parentHash,
      timestamp: Date.now(),
      difficulty: this.chain.difficulty,
      powNonce: 0,
      stateRoot: state.root(),
      txRoot: computeTxRoot(selected),
      txs: selected,
    });
  }

  /** 组装、挖矿并提交 */
  mine(prevHash?: string, txs?: Transaction[]): Block {
    const block = this.buildBlock(prevHash, txs);
    this.submitBlock(block);
    return block;
  }

  /**
   * 提交区块。非法区块抛错且无任何残留。
   * 发生重组时：被回滚区块中未包含在新主链且仍合法的交易回到交易池，
   * 已失效的丢弃；随后按新主链状态重放校验整个交易池。
   */
  submitBlock(block: Block): SubmitResult {
    const result = this.chain.addBlock(block);
    if (result.reorged) {
      for (const tx of result.disconnectedTxs) {
        if (result.includedTxHashes.has(txHash(tx))) continue;
        try {
          this.mempool.add(tx);
        } catch {
          /* 签名都无法验证的直接丢弃 */
        }
      }
    }
    this.mempool.revalidate(this.tipState());
    return { reorged: result.reorged, tip: this.chain.tip.hash, height: this.chain.tip.height };
  }

  balanceOf(address: string): { balance: number; nonce: number } {
    return this.tipState().get(address);
  }

  /** 某账户相对于某区块状态根的包含证明 */
  getProof(blockHash: string, address: string): StateProof {
    const state = this.chain.stateAt(blockHash);
    if (!state) throw new Error('unknown block');
    return state.proof(address);
  }
}
