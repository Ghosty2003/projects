import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import type { KeyPair } from '../src/crypto.js';
import { makeNode, tx } from './helpers.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let base: string;
let ctx: ReturnType<typeof makeNode>;

before(async () => {
  ctx = makeNode(0, [1000, 500, 100]);
  server = createApp(ctx.node);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(() => server.close());

/* eslint-disable @typescript-eslint/no-explicit-any */
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(base + path, init);
  return { status: res.status, body: await res.json() };
}

test('GET / 返回节点信息', async () => {
  const { status, body } = await api('GET', '/');
  assert.equal(status, 200);
  assert.equal(body.height, 0);
  assert.equal(body.poolSize, 0);
});

test('交易提交 → 挖矿 → 余额与证明 → 独立校验', async () => {
  const [alice, bob] = ctx.keys as [KeyPair, KeyPair];

  // 提交交易
  const t = tx(alice, bob.address, 250, 0);
  let r = await api('POST', '/transactions', t);
  assert.equal(r.status, 201);
  assert.match(r.body.hash, /^[0-9a-f]{64}$/);

  // 交易池可见
  r = await api('GET', '/pool');
  assert.equal(r.body.txs.length, 1);

  // 挖矿
  r = await api('POST', '/mine', {});
  assert.equal(r.status, 201);
  const block = r.body.block;
  assert.equal(block.height, 1);
  assert.equal(block.txs.length, 1);

  // 交易池已清空
  r = await api('GET', '/pool');
  assert.equal(r.body.txs.length, 0);

  // 余额正确
  r = await api('GET', `/accounts/${alice.address}`);
  assert.equal(r.body.balance, 750);
  assert.equal(r.body.nonce, 1);
  r = await api('GET', `/accounts/${bob.address}`);
  assert.equal(r.body.balance, 750);

  // 主链信息
  r = await api('GET', '/chain');
  assert.equal(r.body.height, 1);
  assert.equal(r.body.blocks.length, 2);

  // 按区块查询证明并独立校验
  r = await api('GET', `/accounts/${alice.address}/proof?block=${block.hash}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.account.balance, 750);
  assert.equal(r.body.root, block.stateRoot);

  r = await api('POST', '/proofs/verify', r.body);
  assert.deepEqual(r.body, { valid: true });

  // 篡改余额 → 校验失败
  const proofRes = await api('GET', `/accounts/${alice.address}/proof?block=${block.hash}`);
  const tampered = { ...proofRes.body, account: { balance: 1, nonce: 1 } };
  r = await api('POST', '/proofs/verify', tampered);
  assert.deepEqual(r.body, { valid: false });

  // 篡改证明路径 → 校验失败
  const proof2 = (await api('GET', `/accounts/${alice.address}/proof?block=${block.hash}`)).body;
  if (proof2.proof.length > 0) {
    proof2.proof[0].hash = '0'.repeat(64);
    r = await api('POST', '/proofs/verify', proof2);
    assert.deepEqual(r.body, { valid: false });
  }
});

test('非法交易与非法区块通过接口被拒绝', async () => {
  const [alice, bob] = ctx.keys as [KeyPair, KeyPair];
  const tipBefore = ctx.node.chain.tip().block.hash;

  // 坏签名交易
  const bad = tx(alice, bob.address, 10, 1);
  bad.amount = 99999;
  let r = await api('POST', '/transactions', bad);
  assert.equal(r.status, 400);

  // 结构非法的区块
  r = await api('POST', '/blocks', { hello: 'world' });
  assert.equal(r.status, 400);

  // 未知父块
  r = await api('GET', `/blocks/${'f'.repeat(64)}`);
  assert.equal(r.status, 404);

  // 链状态无变化
  assert.equal(ctx.node.chain.tip().block.hash, tipBefore);
  r = await api('GET', '/');
  assert.equal(r.body.height, 1);
});

test('GET /blocks/:hash 返回区块详情', async () => {
  const tip = ctx.node.chain.tip().block.hash;
  const r = await api('GET', `/blocks/${tip}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.block.hash, tip);
  assert.equal(r.body.onMainChain, true);
});
