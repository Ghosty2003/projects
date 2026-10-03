import { generateKeyPair, type KeyPair } from '../src/crypto.js';
import { sealBlock } from '../src/block.js';
import { Node } from '../src/node.js';
import { signTx } from '../src/transaction.js';
import type { Block, Transaction } from '../src/types.js';

export interface TestNode {
  node: Node;
  keys: KeyPair[];
}

/** 默认 difficulty=0，任何哈希都满足 PoW，挖矿即时完成。 */
export function makeNode(difficulty = 0, balances: number[] = [1000, 500, 100]): TestNode {
  const keys = balances.map(() => generateKeyPair());
  const node = new Node({
    difficulty,
    alloc: keys.map((k, i) => ({ address: k.address, balance: balances[i]! })),
  });
  return { node, keys };
}

export function tx(kp: KeyPair, to: string, amount: number, nonce: number): Transaction {
  return signTx(kp, to, amount, nonce);
}

let tsCounter = 1;

/** 在指定父块上组装并“挖”一个区块（difficulty=0 时立即返回）。交易必须合法。 */
export function mineOn(node: Node, parentHash: string, txs: Transaction[], timestamp?: number): Block {
  const draft = node.chain.assembleBlock(parentHash, txs, timestamp ?? tsCounter++);
  return sealBlock(draft);
}

/**
 * 不校验交易、直接打包成一个 PoW 合格的区块（stateRoot 取父块状态根，通常因此不匹配）。
 * 用于构造“非法但结构完整”的区块，测试节点验证逻辑。
 */
export function mineRaw(node: Node, parentHash: string, txs: Transaction[], timestamp?: number): Block {
  const parent = node.chain.getBlock(parentHash);
  if (!parent) throw new Error('unknown parent');
  const draft: Block = {
    height: parent.block.height + 1,
    prevHash: parentHash,
    timestamp: timestamp ?? tsCounter++,
    difficulty: node.chain.difficulty,
    nonce: 0,
    txs,
    stateRoot: parent.block.stateRoot,
    hash: '',
  };
  return sealBlock(draft);
}

/** 在指定父块上挖矿并直接接入链。 */
export function extend(node: Node, parentHash: string, txs: Transaction[], timestamp?: number): Block {
  const block = mineOn(node, parentHash, txs, timestamp);
  const result = node.chain.addBlock(block);
  if (result.status === 'invalid' || result.status === 'orphan') {
    throw new Error(`extend failed: ${result.status} ${result.reason ?? ''}`);
  }
  return block;
}
