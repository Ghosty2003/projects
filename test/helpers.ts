import { addressOf, generateKeyPair, signTx } from '../src/crypto.js';
import { computeTxRoot, sealBlock, type Chain } from '../src/chain.js';
import { Node } from '../src/node.js';
import type { Block, Transaction } from '../src/types.js';

export interface Wallet {
  publicKey: string;
  privateKey: string;
  address: string;
}

export function makeWallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey, privateKey, address: addressOf(publicKey) };
}

export function transfer(wallet: Wallet, to: string, amount: number, nonce: number): Transaction {
  return signTx({ from: wallet.address, to, amount, nonce }, wallet.privateKey, wallet.publicKey);
}

let timestamp = 1;

export interface CraftOptions {
  difficulty?: number;
  /** 跳过状态执行，直接使用给定的状态根（用于构造非法区块） */
  stateRoot?: string;
}

/** 在指定父块上构造一个带有效 PoW 的区块；默认在父状态副本上执行交易得到状态根 */
export function craftBlock(chain: Chain, prevHash: string, txs: Transaction[], opts: CraftOptions = {}): Block {
  const parent = chain.get(prevHash);
  if (!parent) throw new Error('unknown parent');
  let stateRoot = opts.stateRoot;
  if (stateRoot === undefined) {
    const state = chain.stateAt(prevHash);
    if (!state) throw new Error('unknown parent state');
    state.applyBlock(txs);
    stateRoot = state.root();
  }
  return sealBlock({
    height: parent.height + 1,
    prevHash,
    timestamp: timestamp++,
    difficulty: opts.difficulty ?? chain.difficulty,
    powNonce: 0,
    stateRoot,
    txRoot: computeTxRoot(txs),
    txs,
  });
}

export function makeNode(alloc: Record<string, number>, difficulty = 2): Node {
  return new Node({ alloc, difficulty });
}
