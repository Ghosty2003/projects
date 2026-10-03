import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KeyPair } from '../src/crypto.js';
import { makeNode, tx, mineRaw, extend } from './helpers.js';

test('交易池拒绝同 nonce 的双花交易', () => {
  const { node, keys } = makeNode(0, [100, 500, 100]);
  const [alice, bob, carol] = keys as [KeyPair, KeyPair, KeyPair];
  const state = () => node.chain.tip().state;

  node.chain.pool.add(tx(alice, bob.address, 100, 0), state());
  // 同一 nonce 再花一次 → 拒绝
  assert.throws(
    () => node.chain.pool.add(tx(alice, carol.address, 100, 0), state()),
    /already pending/,
  );
  // 累计超支：nonce 1 再花 100，超过余额 → 拒绝
  assert.throws(
    () => node.chain.pool.add(tx(alice, carol.address, 1, 1), state()),
    /insufficient/,
  );
});

test('块内双花（同 nonce 两笔）→ 整块拒绝', () => {
  const { node, keys } = makeNode(0, [100, 500, 100]);
  const [alice, bob, carol] = keys as [KeyPair, KeyPair, KeyPair];
  const tipBefore = node.chain.tip().block.hash;

  const txs = [tx(alice, bob.address, 60, 0), tx(alice, carol.address, 60, 0)];
  const block = mineRaw(node, tipBefore, txs);
  const result = node.chain.addBlock(block);
  assert.equal(result.status, 'invalid');
  assert.equal(node.chain.tip().block.hash, tipBefore);
  assert.equal(node.chain.tip().state.get(alice.address).balance, 100);
});

test('跨分叉双花：重组后只有主链上的花费生效', () => {
  const { node, keys } = makeNode(0, [100, 500, 100]);
  const [alice, bob, carol] = keys as [KeyPair, KeyPair, KeyPair];
  const g = node.chain.genesisHash;

  // 主链 A：alice 把全部 100 转给 bob
  const a1 = extend(node, g, [tx(alice, bob.address, 100, 0)]);
  extend(node, a1.hash, []);
  assert.equal(node.chain.tip().state.get(bob.address).balance, 600);

  // 分叉 B：alice 把同样的 100 转给 carol（双花），B 更长
  const b1 = extend(node, g, [tx(alice, carol.address, 100, 0)]);
  const b2 = extend(node, b1.hash, []);
  const b3 = extend(node, b2.hash, []);
  assert.equal(node.chain.tip().block.hash, b3.hash);

  // 重组后：bob 没收到钱，carol 收到了；A 链的双花交易 nonce 已被占用，不得回流
  const state = node.chain.tip().state;
  assert.equal(state.get(bob.address).balance, 500);
  assert.equal(state.get(carol.address).balance, 200);
  assert.equal(state.get(alice.address).balance, 0);
  assert.equal(node.chain.pool.size, 0);
});

test('余额不足的交易无法进入交易池', () => {
  const { node, keys } = makeNode(0, [50, 500]);
  const [alice, bob] = keys as [KeyPair, KeyPair];
  assert.throws(
    () => node.chain.pool.add(tx(alice, bob.address, 51, 0), node.chain.tip().state),
    /insufficient/,
  );
  assert.equal(node.chain.pool.size, 0);
});

test('nonce 空洞的交易无法进入交易池', () => {
  const { node, keys } = makeNode(0, [1000, 500]);
  const [alice, bob] = keys as [KeyPair, KeyPair];
  assert.throws(
    () => node.chain.pool.add(tx(alice, bob.address, 10, 3), node.chain.tip().state),
    /gap/,
  );
  assert.equal(node.chain.pool.size, 0);
});

test('已上链的 nonce 不能再次入池', () => {
  const { node, keys } = makeNode(0, [1000, 500]);
  const [alice, bob] = keys as [KeyPair, KeyPair];
  extend(node, node.chain.tip().block.hash, [tx(alice, bob.address, 10, 0)]);
  assert.throws(
    () => node.chain.pool.add(tx(alice, bob.address, 20, 0), node.chain.tip().state),
    /consumed/,
  );
});
