import { canonical, sha256hex, txHash } from './crypto.js';
import { merkleRoot } from './merkle.js';
import { StateMachine } from './state.js';
import type { Block, Transaction } from './types.js';

export const ZERO_HASH = '0'.repeat(64);

export interface BlockHeaderFields {
  height: number;
  prevHash: string;
  timestamp: number;
  difficulty: number;
  powNonce: number;
  stateRoot: string;
  txRoot: string;
}

export function computeBlockHash(h: BlockHeaderFields): string {
  return sha256hex(
    canonical({
      height: h.height,
      prevHash: h.prevHash,
      timestamp: h.timestamp,
      difficulty: h.difficulty,
      powNonce: h.powNonce,
      stateRoot: h.stateRoot,
      txRoot: h.txRoot,
    }),
  );
}

export function computeTxRoot(txs: Transaction[]): string {
  return merkleRoot(txs.map((tx) => txHash(tx)));
}

/** 单块工作量：16^difficulty，累计难度为各块工作量之和 */
export function blockWork(difficulty: number): bigint {
  return 16n ** BigInt(difficulty);
}

export function meetsDifficulty(hash: string, difficulty: number): boolean {
  return hash.startsWith('0'.repeat(difficulty));
}

/** 为无哈希的区块寻找满足难度的 powNonce 并计算哈希（挖矿） */
export function sealBlock(fields: Omit<Block, 'hash'>): Block {
  let powNonce = fields.powNonce;
  for (;;) {
    const hash = computeBlockHash({ ...fields, powNonce });
    if (meetsDifficulty(hash, fields.difficulty)) return { ...fields, powNonce, hash };
    powNonce += 1;
  }
}

export interface ReorgResult {
  reorged: boolean;
  /** 被回滚区块中的全部交易 */
  disconnectedTxs: Transaction[];
  /** 新主链分叉段中包含的交易哈希 */
  includedTxHashes: Set<string>;
}

interface StoredBlock {
  block: Block;
  cumulativeWork: bigint;
}

/**
 * 区块链：保存所有已知分支的区块与各自的状态快照，
 * 主链 = 累计难度最大的链。状态快照按块存储，重组时直接切换，
 * 天然保证回滚/重放正确与状态根确定。
 */
export class Chain {
  readonly difficulty: number;
  private readonly blocks = new Map<string, StoredBlock>();
  private readonly states = new Map<string, StateMachine>();
  private tipHash: string;
  private tipWork: bigint;

  constructor(alloc: Record<string, number>, difficulty: number) {
    if (!Number.isInteger(difficulty) || difficulty < 1) throw new Error('bad difficulty');
    this.difficulty = difficulty;
    const genesisState = StateMachine.fromAlloc(alloc);
    const genesis = sealBlock({
      height: 0,
      prevHash: ZERO_HASH,
      timestamp: 0,
      difficulty,
      powNonce: 0,
      stateRoot: genesisState.root(),
      txRoot: computeTxRoot([]),
      txs: [],
    });
    const work = blockWork(difficulty);
    this.blocks.set(genesis.hash, { block: genesis, cumulativeWork: work });
    this.states.set(genesis.hash, genesisState);
    this.tipHash = genesis.hash;
    this.tipWork = work;
  }

  get tip(): Block {
    return this.blocks.get(this.tipHash)!.block;
  }

  get cumulativeWork(): bigint {
    return this.tipWork;
  }

  has(hash: string): boolean {
    return this.blocks.has(hash);
  }

  get(hash: string): Block | undefined {
    return this.blocks.get(hash)?.block;
  }

  /** 返回某区块执行后状态的副本（调用方可自由修改） */
  stateAt(hash: string): StateMachine | undefined {
    return this.states.get(hash)?.clone();
  }

  /** 从创世到当前主链顶端 */
  mainChain(): Block[] {
    const out: Block[] = [];
    let cur = this.tipHash;
    while (cur !== ZERO_HASH) {
      const stored = this.blocks.get(cur);
      if (!stored) break;
      out.push(stored.block);
      cur = stored.block.prevHash;
    }
    return out.reverse();
  }

  private ancestors(hash: string): string[] {
    const path: string[] = [];
    let cur: string | undefined = hash;
    while (cur !== undefined && cur !== ZERO_HASH) {
      path.push(cur);
      cur = this.blocks.get(cur)?.block.prevHash;
    }
    return path;
  }

  /**
   * 校验并接入一个区块。任何校验失败都抛错，且不产生任何状态残留。
   * 若接入后累计难度超过当前主链，则切换主链并返回重组信息。
   */
  addBlock(block: Block): ReorgResult {
    if (this.blocks.has(block.hash)) {
      return { reorged: false, disconnectedTxs: [], includedTxHashes: new Set() };
    }
    const state = this.validate(block);
    const parent = this.blocks.get(block.prevHash)!;
    const cumulativeWork = parent.cumulativeWork + blockWork(block.difficulty);
    this.blocks.set(block.hash, { block, cumulativeWork });
    this.states.set(block.hash, state);

    if (cumulativeWork <= this.tipWork) {
      return { reorged: false, disconnectedTxs: [], includedTxHashes: new Set() };
    }

    const oldTip = this.tipHash;
    const newAncestors = new Set(this.ancestors(block.hash));
    const disconnected: string[] = [];
    for (const h of this.ancestors(oldTip)) {
      if (newAncestors.has(h)) break;
      disconnected.push(h);
    }
    const oldAncestors = new Set(this.ancestors(oldTip));
    const included: string[] = [];
    for (const h of this.ancestors(block.hash)) {
      if (oldAncestors.has(h)) break;
      included.push(h);
    }

    this.tipHash = block.hash;
    this.tipWork = cumulativeWork;

    const disconnectedTxs = disconnected.flatMap((h) => this.blocks.get(h)!.block.txs);
    const includedTxHashes = new Set(
      included.flatMap((h) => this.blocks.get(h)!.block.txs.map((tx) => txHash(tx))),
    );
    return { reorged: true, disconnectedTxs, includedTxHashes };
  }

  /**
   * 完整校验：结构、父块、高度、哈希、工作量、交易根，
   * 然后在父状态的副本上逐笔执行交易（签名/nonce/余额），
   * 最后比对状态根。返回执行后的新状态；失败抛错，调用方不存储任何内容。
   */
  private validate(block: Block): StateMachine {
    if (!Number.isInteger(block.height) || block.height < 1) throw new Error('bad height');
    if (!Number.isInteger(block.difficulty) || block.difficulty < this.difficulty) {
      throw new Error('difficulty below chain minimum');
    }
    const parent = this.blocks.get(block.prevHash);
    if (!parent) throw new Error('unknown parent');
    if (block.height !== parent.block.height + 1) throw new Error('height mismatch');
    if (computeBlockHash(block) !== block.hash) throw new Error('bad block hash');
    if (!meetsDifficulty(block.hash, block.difficulty)) throw new Error('insufficient proof of work');
    if (computeTxRoot(block.txs) !== block.txRoot) throw new Error('bad tx root');
    const state = this.states.get(block.prevHash)!.clone();
    state.applyBlock(block.txs);
    if (state.root() !== block.stateRoot) throw new Error('state root mismatch');
    return state;
  }
}
