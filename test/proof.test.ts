import test from 'node:test';
import assert from 'node:assert/strict';
import { craftBlock, makeNode, makeWallet, transfer } from './helpers.js';
import { verifyStateProof } from '../src/merkle.js';

function nodeWithAccounts() {
  const alice = makeWallet();
  const bob = makeWallet();
  const carol = makeWallet();
  const node = makeNode({ [alice.address]: 100 });
  // 两个区块，让三个账户都有余额，状态树有多个叶子
  const b1 = craftBlock(node.chain, node.chain.tip.hash, [transfer(alice, bob.address, 40, 0)]);
  node.submitBlock(b1);
  const b2 = craftBlock(node.chain, b1.hash, [transfer(alice, carol.address, 25, 1)]);
  node.submitBlock(b2);
  return { node, alice, bob, carol };
}

test('余额包含证明：生成并通过独立校验', () => {
  const { node, alice, bob } = nodeWithAccounts();
  const tip = node.chain.tip;

  for (const wallet of [alice, bob]) {
    const proof = node.getProof(tip.hash, wallet.address);
    assert.equal(proof.root, tip.stateRoot, '证明的根与区块状态根一致');
    assert.deepEqual(proof.account, node.balanceOf(wallet.address));
    assert.ok(
      verifyStateProof(proof.root, wallet.address, proof.account!, proof.proof),
      '独立校验通过',
    );
  }

  // 历史区块的证明同样可用
  const prev = node.chain.get(tip.prevHash)!;
  const historical = node.getProof(prev.hash, alice.address);
  assert.equal(historical.root, prev.stateRoot);
  assert.equal(historical.account!.balance, 60);
  assert.ok(verifyStateProof(historical.root, alice.address, historical.account!, historical.proof));
});

test('证明被篡改时校验失败', () => {
  const { node, alice, bob } = nodeWithAccounts();
  const tip = node.chain.tip;
  const proof = node.getProof(tip.hash, alice.address);
  const account = proof.account!;
  assert.ok(proof.proof.length > 0, '多账户状态下证明路径非空');

  const cases: [string, Parameters<typeof verifyStateProof>][] = [
    // 余额被篡改
    ['tampered balance', [proof.root, alice.address, { ...account, balance: account.balance + 1 }, proof.proof]],
    // nonce 被篡改
    ['tampered nonce', [proof.root, alice.address, { ...account, nonce: account.nonce + 1 }, proof.proof]],
    // 地址被篡改（用别人的地址冒充）
    ['tampered address', [proof.root, bob.address, account, proof.proof]],
    // 状态根被篡改
    ['tampered root', ['ff'.repeat(32), alice.address, account, proof.proof]],
    // 路径中某个兄弟哈希被篡改
    ['tampered proof hash', [proof.root, alice.address, account, proof.proof.map((s, i) => (i === 0 ? { ...s, hash: '00'.repeat(32) } : s))]],
    // 路径方向被翻转
    ['flipped position', [proof.root, alice.address, account, proof.proof.map((s) => ({ ...s, position: s.position === 'left' ? 'right' as const : 'left' as const }))]],
    // 路径被截断
    ['truncated proof', [proof.root, alice.address, account, proof.proof.slice(1)]],
    // 用别的账户的证明冒充
    ['foreign proof', [proof.root, alice.address, account, node.getProof(tip.hash, bob.address).proof]],
  ];

  for (const [name, args] of cases) {
    assert.equal(verifyStateProof(...args), false, name);
  }

  // 对照：未篡改的证明仍然通过
  assert.ok(verifyStateProof(proof.root, alice.address, account, proof.proof));
});

test('不存在的账户无法伪造有效证明', () => {
  const { node } = nodeWithAccounts();
  const stranger = makeWallet();
  const tip = node.chain.tip;

  const proof = node.getProof(tip.hash, stranger.address);
  assert.equal(proof.account, null);
  // 为不存在的账户编造余额，校验必须失败
  assert.equal(verifyStateProof(tip.stateRoot, stranger.address, { balance: 999, nonce: 0 }, proof.proof), false);
});
