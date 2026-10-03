import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBlockHash, meetsDifficulty, sealBlock } from '../src/block.js';
import { generateKeyPair, type KeyPair } from '../src/crypto.js';
import { signTx } from '../src/transaction.js';
import { makeNode, tx, mineOn, mineRaw, extend } from './helpers.js';
import type { Block, Transaction } from '../src/types.js';

function snapshot(node: ReturnType<typeof makeNode>['node']) {
  return {
    tip: node.chain.tip().block.hash,
    root: node.chain.tip().block.stateRoot,
    height: node.chain.tip().block.height,
    poolSize: node.chain.pool.size,
  };
}

function assertUnchanged(node: ReturnType<typeof makeNode>['node'], before: ReturnType<typeof snapshot>) {
  const after = snapshot(node);
  assert.deepEqual(after, before, '非法区块不得在链上留下任何残留');
}

test('合法区块被接受并推进主链', () => {
  const { node, keys } = makeNode();
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const block = extend(node, node.chain.tip().block.hash, [tx(alice, bob.address, 100, 0)]);
  assert.equal(node.chain.tip().block.hash, block.hash);
  assert.equal(node.chain.tip().state.get(alice.address).balance, 900);
  assert.equal(node.chain.tip().state.get(alice.address).nonce, 1);
  assert.equal(node.chain.tip().state.get(bob.address).balance, 600);
});

test('未知父块 → orphan，无残留', () => {
  const { node, keys } = makeNode();
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const before = snapshot(node);
  const fakeParent = 'a'.repeat(64);
  const block: Block = {
    height: 1, prevHash: fakeParent, timestamp: 1, difficulty: 0, nonce: 0,
    txs: [tx(alice, bob.address, 1, 0)], stateRoot: 'b'.repeat(64), hash: '',
  };
  block.hash = computeBlockHash(block);
  const result = node.chain.addBlock(block);
  assert.equal(result.status, 'orphan');
  assertUnchanged(node, before);
});

test('坏签名交易 → 整块拒绝，无残留', () => {
  const { node, keys } = makeNode();
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const before = snapshot(node);
  const good = tx(alice, bob.address, 100, 0);
  const bad: Transaction = { ...good, amount: 999 }; // 改动金额但未重签
  const block = mineRaw(node, node.chain.tip().block.hash, [bad]);
  const result = node.chain.addBlock(block);
  assert.equal(result.status, 'invalid');
  assert.match(result.reason!, /signature|shape/);
  assertUnchanged(node, before);
});

test('nonce 不连续 → 整块拒绝，无残留', () => {
  const { node, keys } = makeNode();
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const before = snapshot(node);
  // 直接跳到 nonce 1，缺少 nonce 0
  const block = mineRaw(node, node.chain.tip().block.hash, [tx(alice, bob.address, 10, 1)]);
  const result = node.chain.addBlock(block);
  assert.equal(result.status, 'invalid');
  assert.match(result.reason!, /nonce/);
  assertUnchanged(node, before);
});

test('余额不足 → 整块拒绝，无残留', () => {
  const { node, keys } = makeNode();
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const before = snapshot(node);
  const block = mineRaw(node, node.chain.tip().block.hash, [tx(alice, bob.address, 100_000, 0)]);
  const result = node.chain.addBlock(block);
  assert.equal(result.status, 'invalid');
  assert.match(result.reason!, /insufficient/);
  assertUnchanged(node, before);
});

test('块内多笔交易累计超支 → 整块拒绝（原子性）', () => {
  const { node, keys } = makeNode();
  const [alice, bob, carol] = keys as [KeyPair, KeyPair, KeyPair];
  const before = snapshot(node);
  // alice 余额 1000：600 + 500 各自合法，合计超支
  const txs = [tx(alice, bob.address, 600, 0), tx(alice, carol.address, 500, 1)];
  const block = mineRaw(node, node.chain.tip().block.hash, txs);
  const result = node.chain.addBlock(block);
  assert.equal(result.status, 'invalid');
  assertUnchanged(node, before);
  // 第一笔交易也不应部分生效
  assert.equal(node.chain.tip().state.get(alice.address).balance, 1000);
  assert.equal(node.chain.tip().state.get(bob.address).balance, 500);
});

test('状态根被篡改 → 拒绝，无残留', () => {
  const { node, keys } = makeNode();
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const before = snapshot(node);
  const block = mineOn(node, node.chain.tip().block.hash, [tx(alice, bob.address, 10, 0)]);
  const tampered: Block = { ...block, stateRoot: '0'.repeat(64) };
  tampered.hash = computeBlockHash(tampered);
  const sealed = sealBlock(tampered);
  const result = node.chain.addBlock(sealed);
  assert.equal(result.status, 'invalid');
  assert.match(result.reason!, /state root/);
  assertUnchanged(node, before);
});

test('哈希与内容不符 → 拒绝', () => {
  const { node, keys } = makeNode();
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const before = snapshot(node);
  const block = mineOn(node, node.chain.tip().block.hash, [tx(alice, bob.address, 10, 0)]);
  const forged: Block = { ...block, hash: 'e'.repeat(64) };
  const result = node.chain.addBlock(forged);
  assert.equal(result.status, 'invalid');
  assert.match(result.reason!, /hash mismatch/);
  assertUnchanged(node, before);
});

test('工作量不足 → 拒绝，无残留', () => {
  const { node, keys } = makeNode(8); // 要求 8 个前导零比特
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const before = snapshot(node);
  const draft = node.chain.assembleBlock(node.chain.tip().block.hash, [tx(alice, bob.address, 10, 0)], 12345);
  // 找一个不满足难度的 nonce
  let bad: Block = { ...draft, nonce: 0 };
  bad.hash = computeBlockHash(bad);
  while (meetsDifficulty(bad.hash, 8)) {
    bad = { ...bad, nonce: bad.nonce + 1 };
    bad.hash = computeBlockHash(bad);
  }
  const result = node.chain.addBlock(bad);
  assert.equal(result.status, 'invalid');
  assert.match(result.reason!, /proof of work/);
  assertUnchanged(node, before);

  // 对照：正确挖矿的区块被接受
  const good = sealBlock(draft);
  assert.equal(node.chain.addBlock(good).status, 'main');
});

test('难度参数与节点不一致 → 拒绝', () => {
  const { node, keys } = makeNode(4);
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const before = snapshot(node);
  const draft = node.chain.assembleBlock(node.chain.tip().block.hash, [tx(alice, bob.address, 10, 0)], 99);
  const wrong: Block = { ...draft, difficulty: 0 };
  wrong.hash = computeBlockHash(wrong);
  const result = node.chain.addBlock(wrong);
  assert.equal(result.status, 'invalid');
  assert.match(result.reason!, /difficulty/);
  assertUnchanged(node, before);
});

test('高度不连续 → 拒绝', () => {
  const { node, keys } = makeNode();
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const b1 = extend(node, node.chain.tip().block.hash, []);
  const before = snapshot(node);
  // 构造 height 跳变的块
  const draft = node.chain.assembleBlock(b1.hash, [tx(alice, bob.address, 10, 0)], 777);
  const skipped: Block = { ...draft, height: draft.height + 5 };
  skipped.hash = computeBlockHash(skipped);
  const result = node.chain.addBlock(skipped);
  assert.equal(result.status, 'invalid');
  assert.match(result.reason!, /height/);
  assertUnchanged(node, before);
});

test('伪造他人交易（公钥与 from 不符）→ 拒绝', () => {
  const { node, keys } = makeNode();
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const before = snapshot(node);
  const mallory = generateKeyPair();
  // mallory 用自己的私钥签名，但 from 填 alice 的地址
  const forged = signTx(mallory, bob.address, 10, 0);
  forged.from = alice.address;
  const block = mineRaw(node, node.chain.tip().block.hash, [forged]);
  const result = node.chain.addBlock(block);
  assert.equal(result.status, 'invalid');
  assertUnchanged(node, before);
});
