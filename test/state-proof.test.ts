import { test } from 'node:test';
import assert from 'node:assert/strict';
import { State } from '../src/state.js';
import { verifyProof } from '../src/merkle.js';
import { generateKeyPair, type KeyPair } from '../src/crypto.js';
import { makeNode, tx, extend } from './helpers.js';

test('状态根与账户插入顺序无关', () => {
  const a = generateKeyPair().address;
  const b = generateKeyPair().address;
  const c = generateKeyPair().address;

  const s1 = State.fromAlloc([
    { address: a, balance: 10 },
    { address: b, balance: 20 },
    { address: c, balance: 30 },
  ]);
  const s2 = State.fromAlloc([
    { address: c, balance: 30 },
    { address: a, balance: 10 },
    { address: b, balance: 20 },
  ]);
  assert.equal(s1.root(), s2.root());

  // 交易路径不同但最终状态相同 → 状态根相同
  const { node, keys } = makeNode(0, [100, 100]);
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const g = node.chain.genesisHash;
  // 路径一：alice→bob 30，然后 bob→alice 10
  const p1 = extend(node, g, [tx(alice, bob.address, 30, 0)]);
  extend(node, p1.hash, [tx(bob, alice.address, 10, 0)]);
  // 路径二（另一条分支）：bob→alice 10，然后 alice→bob 30 —— 最终状态相同
  const q1 = extend(node, g, [tx(bob, alice.address, 10, 0)]);
  const q2 = extend(node, q1.hash, [tx(alice, bob.address, 30, 0)]);
  assert.equal(node.chain.getBlock(q2.hash)!.block.stateRoot, node.chain.tip().block.stateRoot);
});

test('包含证明可独立校验，篡改后校验失败', () => {
  const { node, keys } = makeNode(0, [1000, 500]);
  const [alice, bob] = keys as [KeyPair, KeyPair];
  node.chain.pool.add(tx(alice, bob.address, 200, 0), node.chain.tip().state);
  const block = node.mine();

  const state = node.chain.stateAt(block.hash)!;
  const found = state.prove(alice.address)!;
  const root = state.root();
  assert.equal(found.account.balance, 800);
  assert.equal(found.account.nonce, 1);

  // 正常校验通过
  assert.ok(verifyProof(root, alice.address, found.account, found.proof));

  // 篡改余额 → 失败
  assert.ok(!verifyProof(root, alice.address, { balance: 999999, nonce: 1 }, found.proof));
  // 篡改 nonce → 失败
  assert.ok(!verifyProof(root, alice.address, { balance: 800, nonce: 7 }, found.proof));
  // 篡改地址 → 失败
  assert.ok(!verifyProof(root, bob.address, found.account, found.proof));
  // 篡改证明路径中的哈希 → 失败
  const tampered = found.proof.map((s, i) =>
    i === 0 ? { ...s, hash: '0'.repeat(64) } : s,
  );
  if (tampered.length > 0) {
    assert.ok(!verifyProof(root, alice.address, found.account, tampered));
  }
  // 交换证明步骤位置 → 失败（多步路径时）
  if (found.proof.length > 1) {
    const swapped = [...found.proof].reverse();
    assert.ok(!verifyProof(root, alice.address, found.account, swapped));
  }
  // 错误的根 → 失败
  assert.ok(!verifyProof('f'.repeat(64), alice.address, found.account, found.proof));
});

test('重组前后同一状态的状态根保持确定', () => {
  const { node, keys } = makeNode(0, [1000, 500]);
  const [alice, bob] = keys as [KeyPair, KeyPair];
  const g = node.chain.genesisHash;

  // 主链 A：两个块
  const a1 = extend(node, g, [tx(alice, bob.address, 100, 0)]);
  const a2 = extend(node, a1.hash, [tx(alice, bob.address, 50, 1)]);
  const rootA1 = node.chain.getBlock(a1.hash)!.block.stateRoot;
  const rootA2 = node.chain.getBlock(a2.hash)!.block.stateRoot;

  // 分叉 B 更长，触发重组
  let parent = g;
  for (let i = 0; i < 3; i++) {
    parent = extend(node, parent, [tx(bob, alice.address, 10, i)]).hash;
  }
  assert.equal(node.chain.tip().block.hash, parent);
  assert.notEqual(node.chain.tip().block.stateRoot, rootA2);

  // A 链继续延长重新成为主链，同一高度的状态根必须与之前一致
  const a3 = extend(node, a2.hash, []);
  const a4 = extend(node, a3.hash, []);
  assert.equal(node.chain.tip().block.hash, a4.hash);
  assert.equal(node.chain.getBlock(a1.hash)!.block.stateRoot, rootA1);
  assert.equal(node.chain.getBlock(a2.hash)!.block.stateRoot, rootA2);
});
