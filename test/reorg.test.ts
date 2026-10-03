import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KeyPair } from '../src/crypto.js';
import { txHash } from '../src/transaction.js';
import { makeNode, tx, extend } from './helpers.js';

test('深层重组：更长分叉成为主链，状态正确切换', () => {
  const { node, keys } = makeNode(0, [1000, 500, 100]);
  const [alice, bob, carol] = keys as [KeyPair, KeyPair, KeyPair];
  const g = node.chain.genesisHash;

  // 主链 A：6 个块
  let parentA = g;
  for (let i = 0; i < 6; i++) {
    parentA = extend(node, parentA, [tx(alice, bob.address, 10, i)]).hash;
  }
  assert.equal(node.chain.tip().block.height, 6);
  assert.equal(node.chain.tip().state.get(alice.address).balance, 940);
  assert.equal(node.chain.tip().state.get(bob.address).balance, 560);

  // 分叉 B：从创世块开始的 7 个块（深度 6 的重组）
  let parentB = g;
  for (let i = 0; i < 6; i++) {
    const b = extend(node, parentB, [tx(bob, carol.address, 5, i)]);
    parentB = b.hash;
    assert.equal(node.chain.tip().block.hash, parentA, 'B 链尚短时不应切换主链');
  }
  const b7 = extend(node, parentB, [tx(bob, carol.address, 5, 6)]);
  assert.equal(node.chain.tip().block.hash, b7.hash, 'B 链累计难度更大，应成为主链');
  assert.equal(node.chain.tip().block.height, 7);

  // 状态必须完全反映 B 链：alice 未动，bob 转出 35
  const state = node.chain.tip().state;
  assert.equal(state.get(alice.address).balance, 1000);
  assert.equal(state.get(alice.address).nonce, 0);
  assert.equal(state.get(bob.address).balance, 500 - 35);
  assert.equal(state.get(bob.address).nonce, 7);
  assert.equal(state.get(carol.address).balance, 100 + 35);
});

test('重组后被回滚的合法交易回流交易池，失效交易被丢弃', () => {
  const { node, keys } = makeNode(0, [1000, 500, 100]);
  const [alice, bob, carol] = keys as [KeyPair, KeyPair, KeyPair];
  const g = node.chain.genesisHash;

  // 主链 A：alice→bob 100 (nonce 0)，alice→carol 50 (nonce 1)
  const txA0 = tx(alice, bob.address, 100, 0);
  const txA1 = tx(alice, carol.address, 50, 1);
  const a1 = extend(node, g, [txA0]);
  extend(node, a1.hash, [txA1]);
  assert.equal(node.chain.pool.size, 0);

  // 分叉 B：包含一笔与 txA0 冲突的交易（alice 的 nonce 0 被占用）
  const txB0 = tx(alice, carol.address, 70, 0);
  const b1 = extend(node, g, [txB0]);
  const b2 = extend(node, b1.hash, []);
  const b3 = extend(node, b2.hash, []);
  assert.equal(node.chain.tip().block.hash, b3.hash, 'B 链更长，触发重组');

  // txA0 的 nonce 0 已被 txB0 占用 → 失效丢弃；txA1 的 nonce 1 仍合法 → 回流池中
  const poolTxs = node.chain.pool.list();
  assert.equal(poolTxs.length, 1);
  assert.equal(txHash(poolTxs[0]!), txHash(txA1));

  // 回流的交易可以重新被打包上链
  node.mine();
  assert.equal(node.chain.pool.size, 0);
  assert.equal(node.chain.tip().state.get(carol.address).balance, 100 + 70 + 50);
});

test('被回滚交易若已包含在新主链则不回流', () => {
  const { node, keys } = makeNode(0, [1000, 500]);
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const g = node.chain.genesisHash;

  const shared = tx(alice, bob.address, 100, 0);
  const a1 = extend(node, g, [shared]);
  extend(node, a1.hash, [tx(alice, bob.address, 10, 1)]);

  // B 链也包含 shared，且更长
  const b1 = extend(node, g, [shared]);
  const b2 = extend(node, b1.hash, []);
  const b3 = extend(node, b2.hash, []);
  assert.equal(node.chain.tip().block.hash, b3.hash);

  // shared 已在新主链上，不回流；alice nonce 1 的交易仍合法，回流
  const poolTxs = node.chain.pool.list();
  assert.equal(poolTxs.length, 1);
  assert.equal(poolTxs[0]!.nonce, 1);
});

test('同高度状态根在重组前后保持确定', () => {
  const { node, keys } = makeNode(0, [1000, 500]);
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const g = node.chain.genesisHash;

  const a1 = extend(node, g, [tx(alice, bob.address, 100, 0)]);
  const a2 = extend(node, a1.hash, [tx(bob, alice.address, 30, 0)]);
  const rootsBefore = [a1, a2].map((b) => node.chain.getBlock(b.hash)!.block.stateRoot);

  // B 链触发重组
  let p = g;
  for (let i = 0; i < 3; i++) p = extend(node, p, []).hash;
  assert.equal(node.chain.tip().block.hash, p);

  // A 链延长后重新成为主链：同高度状态根不变
  const a3 = extend(node, a2.hash, []);
  const a4 = extend(node, a3.hash, []);
  assert.equal(node.chain.tip().block.hash, a4.hash);
  const rootsAfter = [a1, a2].map((b) => node.chain.getBlock(b.hash)!.block.stateRoot);
  assert.deepEqual(rootsAfter, rootsBefore);
});

test('累计难度相同不切换主链（先见为主）', () => {
  const { node, keys } = makeNode(0, [1000, 500]);
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const g = node.chain.genesisHash;

  const a1 = extend(node, g, [tx(alice, bob.address, 10, 0)]);
  const b1 = extend(node, g, [tx(alice, bob.address, 20, 0)]);
  assert.equal(node.chain.tip().block.hash, a1.hash, '累计难度相同，保持原主链');
  assert.equal(node.chain.getBlock(b1.hash)!.block.height, 1, '侧链块仍被保存');
});
