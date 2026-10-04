import test from 'node:test';
import assert from 'node:assert/strict';
import { craftBlock, makeNode, makeWallet, transfer } from './helpers.js';
import { computeBlockHash, computeTxRoot, meetsDifficulty, sealBlock } from '../src/chain.js';
import type { Block } from '../src/types.js';

test('合法区块被接受并更新余额与 nonce', () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const node = makeNode({ [alice.address]: 100 });

  const tx = transfer(alice, bob.address, 30, 0);
  const block = craftBlock(node.chain, node.chain.tip.hash, [tx]);
  const result = node.submitBlock(block);

  assert.equal(node.chain.tip.hash, block.hash);
  assert.equal(result.height, 1);
  assert.equal(node.balanceOf(alice.address).balance, 70);
  assert.equal(node.balanceOf(alice.address).nonce, 1);
  assert.equal(node.balanceOf(bob.address).balance, 30);
});

test('非法区块（签名/nonce/余额/父块/PoW/状态根）整块拒绝且无任何残留', () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const node = makeNode({ [alice.address]: 100 });
  const genesis = node.chain.tip.hash;
  const genesisRoot = node.chain.tip.stateRoot;

  const good = transfer(alice, bob.address, 10, 0);
  // 交易本身无法执行（签名/nonce/余额）时，craftBlock 无法算出合法状态根，
  // 故显式给定占位状态根 —— 区块应在执行交易阶段被拒绝，而非构造阶段。
  const cases: [string, () => Block][] = [
    // 签名被篡改：签名后改动金额
    ['bad signature', () => craftBlock(node.chain, genesis, [{ ...good, amount: 11 }], { stateRoot: genesisRoot })],
    // nonce 不连续
    ['bad nonce', () => craftBlock(node.chain, genesis, [transfer(alice, bob.address, 10, 5)], { stateRoot: genesisRoot })],
    // 余额不足
    ['insufficient balance', () => craftBlock(node.chain, genesis, [transfer(alice, bob.address, 1000, 0)], { stateRoot: genesisRoot })],
    // 未知父块（craftBlock 会查父块，故直接手工封块）
    ['unknown parent', () => sealBlock({
      height: 1,
      prevHash: 'ab'.repeat(32),
      timestamp: 1,
      difficulty: node.chain.difficulty,
      powNonce: 0,
      stateRoot: genesisRoot,
      txRoot: computeTxRoot([]),
      txs: [],
    })],
    // 状态根与执行结果不符
    ['state root mismatch', () => craftBlock(node.chain, genesis, [good], { stateRoot: 'cd'.repeat(32) })],
    // 哈希与内容不符
    ['bad hash', () => {
      const b = craftBlock(node.chain, genesis, [good]);
      return { ...b, powNonce: b.powNonce + 1 };
    }],
    // 工作量不足：构造一个哈希有效但不满足更高难度的区块
    ['insufficient pow', () => {
      let b = craftBlock(node.chain, genesis, [good]);
      for (let ts = 100000; ; ts++) {
        const candidate = { ...b, timestamp: ts, difficulty: b.difficulty + 2 };
        const hash = computeBlockHash(candidate);
        if (!meetsDifficulty(hash, candidate.difficulty)) {
          return { ...candidate, hash };
        }
      }
    }],
  ];

  for (const [name, make] of cases) {
    const block = make();
    assert.throws(() => node.submitBlock(block), `rejected: ${name}`);
    // 无残留：主链、状态根、交易池均未变化
    assert.equal(node.chain.tip.hash, genesis, name);
    assert.equal(node.chain.tip.stateRoot, genesisRoot, name);
    assert.equal(node.mempool.size, 0, name);
    assert.equal(node.chain.has(block.hash), false, name);
    assert.equal(node.balanceOf(alice.address).balance, 100, name);
    assert.equal(node.balanceOf(alice.address).nonce, 0, name);
  }
});

test('同一块中同 nonce 双花导致整块拒绝', () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const carol = makeWallet();
  const node = makeNode({ [alice.address]: 100 });

  const tx1 = transfer(alice, bob.address, 30, 0);
  const tx2 = transfer(alice, carol.address, 30, 0); // 同 nonce 双花
  // craftBlock 默认会执行交易并因 nonce 冲突抛错；这里直接给定状态根以构造出该非法区块
  const block = craftBlock(node.chain, node.chain.tip.hash, [tx1, tx2], { stateRoot: '00'.repeat(32) });

  assert.throws(() => node.submitBlock(block));
  assert.equal(node.chain.tip.height, 0);
  assert.equal(node.balanceOf(alice.address).balance, 100);
  assert.equal(node.balanceOf(bob.address).balance, 0);
  assert.equal(node.balanceOf(carol.address).balance, 0);
});
