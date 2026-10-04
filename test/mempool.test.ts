import test from 'node:test';
import assert from 'node:assert/strict';
import { craftBlock, makeNode, makeWallet, transfer } from './helpers.js';
import { txHash } from '../src/crypto.js';

test('重组后被回滚区块中仍合法的交易回到交易池，并可重新打包', () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const carol = makeWallet();
  const node = makeNode({ [alice.address]: 100 });
  const genesis = node.chain.tip.hash;

  // 旧主链两个区块，各含一笔交易
  const txA = transfer(alice, bob.address, 10, 0);
  const txB = transfer(alice, carol.address, 5, 1);
  const b1 = craftBlock(node.chain, genesis, [txA]);
  node.submitBlock(b1);
  const b2 = craftBlock(node.chain, b1.hash, [txB]);
  node.submitBlock(b2);
  assert.equal(node.mempool.size, 0);

  // 分叉：从创世起 3 个空块，累计难度超过旧主链（2 块）
  let prev = genesis;
  let reorged = false;
  for (let i = 0; i < 3; i++) {
    const f = craftBlock(node.chain, prev, []);
    if (node.submitBlock(f).reorged) reorged = true;
    prev = f.hash;
  }
  assert.ok(reorged);

  // txA、txB 未包含在新主链且仍然合法 → 回到交易池
  assert.equal(node.mempool.size, 2);
  assert.ok(node.mempool.has(txHash(txA)));
  assert.ok(node.mempool.has(txHash(txB)));

  // 重新打包进新主链后交易池清空，余额与旧主链一致
  node.mine();
  assert.equal(node.mempool.size, 0);
  assert.equal(node.balanceOf(alice.address).balance, 85);
  assert.equal(node.balanceOf(bob.address).balance, 10);
  assert.equal(node.balanceOf(carol.address).balance, 5);
});

test('双花：重组后冲突交易已失效，不得回到交易池', () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const carol = makeWallet();
  const node = makeNode({ [alice.address]: 100 });
  const genesis = node.chain.tip.hash;

  // 主链：alice -> bob 80（nonce 0）
  const spend = transfer(alice, bob.address, 80, 0);
  const b1 = craftBlock(node.chain, genesis, [spend]);
  node.submitBlock(b1);
  assert.equal(node.balanceOf(bob.address).balance, 80);

  // 攻击者分叉：同一笔资金 alice -> carol 80（nonce 0），并加一块空块使分叉更重
  const doubleSpend = transfer(alice, carol.address, 80, 0);
  const f1 = craftBlock(node.chain, genesis, [doubleSpend]);
  assert.equal(node.submitBlock(f1).reorged, false, '累计难度相同，暂不重组');
  const f2 = craftBlock(node.chain, f1.hash, []);
  assert.equal(node.submitBlock(f2).reorged, true);

  // 双花成功替换主链：bob 的 80 被回滚，carol 得到 80
  assert.equal(node.balanceOf(alice.address).balance, 20);
  assert.equal(node.balanceOf(bob.address).balance, 0);
  assert.equal(node.balanceOf(carol.address).balance, 80);

  // 被回滚的 spend 与新主链的 doubleSpend nonce 冲突（nonce 0 已被消费）→ 丢弃，不回流
  assert.equal(node.mempool.size, 0);
  assert.ok(!node.mempool.has(txHash(spend)));
});

test('交易池拒绝 nonce 低于账户当前 nonce 的交易', () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const node = makeNode({ [alice.address]: 100 });

  const tx = transfer(alice, bob.address, 10, 0);
  const block = craftBlock(node.chain, node.chain.tip.hash, [tx]);
  node.submitBlock(block);

  // nonce 0 已被主链消费
  assert.throws(() => node.submitTx(transfer(alice, bob.address, 5, 0)), /nonce too low/);
  // 合法 nonce 可入池
  node.submitTx(transfer(alice, bob.address, 5, 1));
  assert.equal(node.mempool.size, 1);
});

test('已入池交易被主链区块包含后从交易池移除', () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const node = makeNode({ [alice.address]: 100 });

  const tx = transfer(alice, bob.address, 10, 0);
  node.submitTx(tx);
  assert.equal(node.mempool.size, 1);

  node.mine();
  assert.equal(node.mempool.size, 0);
  assert.equal(node.balanceOf(bob.address).balance, 10);
});
