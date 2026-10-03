import { computeBlockHash, isValidBlockShape, meetsDifficulty } from './block.js';
import { State } from './state.js';
import { TxPool } from './txpool.js';
import { txHash, verifyTx } from './transaction.js';
import type { Block, Transaction } from './types.js';

export interface ChainConfig {
  /** 每个区块要求的前导零比特数（全网恒定） */
  difficulty: number;
  /** 创世分配 */
  alloc: Array<{ address: string; balance: number }>;
}

export type AddBlockStatus = 'main' | 'side' | 'reorg' | 'orphan' | 'invalid' | 'known';

export interface AddBlockResult {
  status: AddBlockStatus;
  reason?: string;
}

export interface StoredBlock {
  block: Block;
  /** 从创世到本块的累计难度（每块 2^difficulty） */
  cumDifficulty: bigint;
  /** 应用本块之后的状态快照（不可变） */
  state: State;
}

const ZERO_HASH = '0'.repeat(64);

export class Chain {
  readonly difficulty: number;
  readonly pool = new TxPool();
  private blocks = new Map<string, StoredBlock>();
  private tipHash: string;
  readonly genesisHash: string;

  constructor(config: ChainConfig) {
    this.difficulty = config.difficulty;
    const state = State.fromAlloc(config.alloc);
    const genesis: Block = {
      height: 0,
      prevHash: ZERO_HASH,
      timestamp: 0,
      difficulty: config.difficulty,
      nonce: 0,
      txs: [],
      stateRoot: state.root(),
      hash: '',
    };
    genesis.hash = computeBlockHash(genesis);
    this.blocks.set(genesis.hash, { block: genesis, cumDifficulty: 0n, state });
    this.tipHash = genesis.hash;
    this.genesisHash = genesis.hash;
  }

  tip(): StoredBlock {
    return this.blocks.get(this.tipHash)!;
  }

  getBlock(hash: string): StoredBlock | undefined {
    return this.blocks.get(hash);
  }

  stateAt(hash: string): State | undefined {
    return this.blocks.get(hash)?.state;
  }

  /** 创世到当前主链顶端的哈希序列。 */
  mainChainHashes(): string[] {
    return this.pathTo(this.tipHash);
  }

  private pathTo(hash: string): string[] {
    const path: string[] = [];
    let cur: string | undefined = hash;
    while (cur !== undefined) {
      path.unshift(cur);
      const stored: StoredBlock = this.blocks.get(cur)!;
      cur = stored.block.height === 0 ? undefined : stored.block.prevHash;
    }
    return path;
  }

  /**
   * 组装一个未挖矿的区块：在父块状态克隆上应用交易，计算状态根。
   * 交易非法时抛错，链状态不受影响。
   */
  assembleBlock(parentHash: string, txs: Transaction[], timestamp: number): Block {
    const parent = this.blocks.get(parentHash);
    if (!parent) throw new Error('unknown parent block');
    const state = parent.state.clone();
    for (const tx of txs) {
      if (!verifyTx(tx)) throw new Error('invalid transaction signature or shape');
      state.applyTx(tx);
    }
    const block: Block = {
      height: parent.block.height + 1,
      prevHash: parentHash,
      timestamp,
      difficulty: this.difficulty,
      nonce: 0,
      txs,
      stateRoot: state.root(),
      hash: '',
    };
    block.hash = computeBlockHash(block);
    return block;
  }

  /**
   * 验证并接入一个区块。任何验证失败都返回 invalid 且不留任何残留；
   * 状态应用全程在父状态的克隆上进行，只有全部成功才落库。
   */
  addBlock(input: Block): AddBlockResult {
    if (!isValidBlockShape(input)) return { status: 'invalid', reason: 'malformed block' };
    if (this.blocks.has(input.hash)) return { status: 'known' };
    if (input.height === 0) return { status: 'invalid', reason: 'genesis already exists' };

    const parent = this.blocks.get(input.prevHash);
    if (!parent) return { status: 'orphan', reason: 'unknown parent' };
    if (input.height !== parent.block.height + 1) {
      return { status: 'invalid', reason: `bad height: expected ${parent.block.height + 1}, got ${input.height}` };
    }
    if (input.difficulty !== this.difficulty) {
      return { status: 'invalid', reason: 'unexpected difficulty' };
    }
    if (computeBlockHash(input) !== input.hash) {
      return { status: 'invalid', reason: 'hash mismatch' };
    }
    if (!meetsDifficulty(input.hash, this.difficulty)) {
      return { status: 'invalid', reason: 'insufficient proof of work' };
    }

    // 在父状态克隆上重放交易，失败即整块拒绝，无任何残留
    const state = parent.state.clone();
    for (const tx of input.txs) {
      if (!verifyTx(tx)) return { status: 'invalid', reason: 'invalid transaction signature or shape' };
      try {
        state.applyTx(tx);
      } catch (err) {
        return { status: 'invalid', reason: `transaction failed: ${(err as Error).message}` };
      }
    }
    if (state.root() !== input.stateRoot) {
      return { status: 'invalid', reason: 'state root mismatch' };
    }

    const cumDifficulty = parent.cumDifficulty + (1n << BigInt(this.difficulty));
    this.blocks.set(input.hash, { block: input, cumDifficulty, state });

    const tip = this.tip();
    if (cumDifficulty > tip.cumDifficulty) {
      const extendsTip = input.prevHash === this.tipHash;
      this.switchTip(input.hash);
      return { status: extendsTip ? 'main' : 'reorg' };
    }
    return { status: 'side' };
  }

  /**
   * 将主链切换到 newTipHash：状态直接取目标快照，
   * 交易池移除新主链已包含的交易、清理失效交易、
   * 并把被回滚区块中仍然合法的交易回流到池中。
   */
  private switchTip(newTipHash: string): void {
    const oldPath = this.pathTo(this.tipHash);
    const newPath = this.pathTo(newTipHash);
    let fork = 0;
    while (fork < oldPath.length && fork < newPath.length && oldPath[fork] === newPath[fork]) {
      fork++;
    }
    const rolledBack = oldPath.slice(fork);
    const applied = newPath.slice(fork);
    this.tipHash = newTipHash;

    const state = this.blocks.get(newTipHash)!.state;
    const included = new Set<string>();
    for (const hash of applied) {
      for (const tx of this.blocks.get(hash)!.block.txs) included.add(txHash(tx));
    }
    for (const hash of included) this.pool.remove(hash);
    this.pool.pruneInvalid(state);
    for (const hash of rolledBack) {
      for (const tx of this.blocks.get(hash)!.block.txs) {
        if (included.has(txHash(tx))) continue;
        try {
          this.pool.add(tx, state);
        } catch {
          // 在新主链上已失效（nonce 被占用、余额不足等）：丢弃
        }
      }
    }
  }
}
