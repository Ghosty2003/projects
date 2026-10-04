import test from 'node:test';
import assert from 'node:assert/strict';
import { craftBlock, makeNode, makeWallet, transfer } from './helpers.js';
import { StateMachine } from '../src/state.js';
import type { Block } from '../src/types.js';

/** 依次构造并提交区块，返回区块列表 */
function extendChain(node: ReturnType<typeof makeNode>, prevHash: string, txsPerBlock: Parameters<typeof transfer>[][]): Block[] {
  const blocks: Block[] = [];
  let prev = prevHash;
  for (const txs of txsPerBlock) {
    const signed = txs.map((args) => transfer(...args));
    const block = craftBlock(node.chain, prev, signed);
    node.submitBlock(block);
    blocks.push(block);
    prev = block.hash;
  }
  return blocks;
}

test('深层重组：更重分叉回滚旧主链并重放，账户状态正确', () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const carol = makeWallet();
  const node = makeNode({ [alice.address]: 100 });
  const genesis = node.chain.tip.hash;

  // 旧主链：4 个区块，alice -> bob 各 10（nonce 0..3）
  const oldBlocks = extendChain(
    node,
    genesis,
    [0, 1, 2, 3].map((i) => [[alice, bob.address, 10, i]]),
  );
  assert.equal(node.chain.tip.height, 4);
  assert.equal(node.balanceOf(alice.address).balance, 60);
  assert.equal(node.balanceOf(bob.address).balance, 40);

  // 分叉：从创世起 5 个区块，alice -> carol 各 5（nonce 0..3）+ 1 个空块
  const forkTxs = [0, 1, 2, 3].map((i) => [[alice, carol.address, 5, i]] as Parameters<typeof transfer>[]);
  forkTxs.push([]);
  let prev = genesis;
  let lastResult = { reorged: false };
  const forkBlocks: Block[] = [];
  for (const txs of forkTxs) {
    const signed = txs.map((args) => transfer(...args));
    const block = craftBlock(node.chain, prev, signed);
    lastResult = node.submitBlock(block);
    forkBlocks.push(block);
    prev = block.hash;
  }

  // 第 5 个分叉块使累计难度超过旧主链，触发深层重组
  assert.equal(lastResult.reorged, true);
  assert.equal(node.chain.tip.hash, forkBlocks[4]!.hash);
  assert.equal(node.chain.tip.height, 5);

  // 旧主链状态被完整回滚，分叉状态被正确重放
  assert.equal(node.balanceOf(alice.address).balance, 80);
  assert.equal(node.balanceOf(alice.address).nonce, 4);
  assert.equal(node.balanceOf(bob.address).balance, 0);
  assert.equal(node.balanceOf(carol.address).balance, 20);

  // 主链组成正确：创世 + 5 个分叉块，不含旧主链区块
  const main = node.chain.mainChain();
  assert.deepEqual(main.map((b) => b.hash), [genesis, ...forkBlocks.map((b) => b.hash)]);
  for (const b of oldBlocks) {
    assert.ok(node.chain.has(b.hash), '旧区块仍保留在已知区块中');
    assert.ok(!main.some((m) => m.hash === b.hash), '旧区块不在主链上');
  }
});

test('重组前后同一高度的状态根保持确定', () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const alloc = { [alice.address]: 100 };

  // node1：顺序上链 4 个区块
  const node1 = makeNode(alloc);
  const blocks = extendChain(
    node1,
    node1.chain.tip.hash,
    [0, 1, 2, 3].map((i) => [[alice, bob.address, 7, i]]),
  );

  // node2：先走一条 3 块的空分叉成为主链，再收到 node1 的区块触发重组
  const node2 = makeNode(alloc);
  extendChain(node2, node2.chain.tip.hash, [[], [], []]);
  assert.equal(node2.chain.tip.height, 3);
  const rootsBefore = blocks.map((b) => node2.chain.get(b.hash)?.stateRoot);

  let reorged = false;
  for (const b of blocks) {
    if (node2.submitBlock(b).reorged) reorged = true;
  }
  assert.ok(reorged, 'node1 的 4 块链应重组掉 node2 的 3 块空链');

  // 重组后两个节点的主链完全一致，每个高度的状态根相同
  assert.equal(node2.chain.tip.hash, node1.chain.tip.hash);
  assert.equal(node2.chain.tip.stateRoot, node1.chain.tip.stateRoot);
  for (const b of blocks) {
    assert.equal(node2.chain.get(b.hash)!.stateRoot, b.stateRoot);
    assert.equal(node2.chain.stateAt(b.hash)!.root(), b.stateRoot);
  }
  // 重组前这些区块尚未提交，此处主要断言提交后根与封存值一致（内容寻址，确定性）
  assert.deepEqual(rootsBefore, blocks.map(() => undefined));
});

test('状态根与账户插入顺序无关', () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const carol = makeWallet();

  // 创世分配顺序不同
  const s1 = StateMachine.fromAlloc({ [alice.address]: 100, [bob.address]: 50, [carol.address]: 30 });
  const s2 = StateMachine.fromAlloc({ [carol.address]: 30, [alice.address]: 100, [bob.address]: 50 });
  assert.equal(s1.root(), s2.root());

  // 交易应用顺序不同（三个不同发送方，互不依赖）
  const txAB = transfer(alice, bob.address, 10, 0);
  const txCB = transfer(carol, bob.address, 5, 0);
  const txBA = transfer(bob, alice.address, 3, 0);

  const order1 = StateMachine.fromAlloc({ [alice.address]: 100, [bob.address]: 50, [carol.address]: 30 });
  for (const tx of [txAB, txCB, txBA]) order1.applyTx(tx);

  const order2 = StateMachine.fromAlloc({ [alice.address]: 100, [bob.address]: 50, [carol.address]: 30 });
  for (const tx of [txBA, txCB, txAB]) order2.applyTx(tx);

  assert.equal(order1.root(), order2.root());
});
