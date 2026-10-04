import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { makeNode, makeWallet, transfer } from './helpers.js';
import { createHttpServer } from '../src/server.js';
import type { Block, Transaction } from '../src/types.js';

async function withServer<T>(fn: (base: string, ctx: { alice: ReturnType<typeof makeWallet>; bob: ReturnType<typeof makeWallet> }) => Promise<T>): Promise<T> {
  const alice = makeWallet();
  const bob = makeWallet();
  const node = makeNode({ [alice.address]: 100 });
  const server = createHttpServer(node);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`, { alice, bob });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('HTTP 接口：交易提交、挖矿、余额查询、证明与校验', async () => {
  await withServer(async (base, { alice, bob }) => {
    // 提交交易
    const tx = transfer(alice, bob.address, 30, 0);
    const txRes = await postJson(base, '/tx', tx);
    assert.equal(txRes.status, 200);
    assert.equal(typeof txRes.json.txHash, 'string');

    // 交易池可见
    const mempool = await (await fetch(`${base}/mempool`)).json();
    assert.equal(mempool.txs.length, 1);

    // 挖矿打包
    const mineRes = await postJson(base, '/mine', {});
    assert.equal(mineRes.status, 200);
    const block = mineRes.json as Block;
    assert.equal(block.height, 1);
    assert.equal(block.txs.length, 1);

    // 链信息
    const chain = await (await fetch(`${base}/chain`)).json();
    assert.equal(chain.height, 1);
    assert.equal(chain.tip, block.hash);

    // 余额
    const balance = await (await fetch(`${base}/balance/${alice.address}`)).json();
    assert.equal(balance.balance, 70);
    assert.equal(balance.nonce, 1);

    // 区块查询
    const fetched = await (await fetch(`${base}/block/${block.hash}`)).json();
    assert.equal(fetched.hash, block.hash);

    // 余额包含证明 + 独立校验接口
    const proofRes = await (await fetch(`${base}/proof/${block.hash}/${alice.address}`)).json();
    assert.equal(proofRes.root, block.stateRoot);
    const verify = await postJson(base, '/proof/verify', {
      root: proofRes.root,
      address: alice.address,
      account: proofRes.account,
      proof: proofRes.proof,
    });
    assert.equal(verify.json.valid, true);

    // 篡改余额后校验失败
    const tampered = await postJson(base, '/proof/verify', {
      root: proofRes.root,
      address: alice.address,
      account: { balance: 9999, nonce: 0 },
      proof: proofRes.proof,
    });
    assert.equal(tampered.json.valid, false);
  });
});

test('HTTP 接口：非法交易与非法区块返回 400 且无副作用', async () => {
  await withServer(async (base, { alice, bob }) => {
    // 签名被篡改的交易
    const badTx: Transaction = { ...transfer(alice, bob.address, 10, 0), amount: 11 };
    const txRes = await postJson(base, '/tx', badTx);
    assert.equal(txRes.status, 400);
    const mempool = await (await fetch(`${base}/mempool`)).json();
    assert.equal(mempool.txs.length, 0);

    // 未知父块的区块
    const badBlock = {
      height: 1,
      prevHash: 'ab'.repeat(32),
      timestamp: 1,
      difficulty: 2,
      powNonce: 0,
      stateRoot: 'cd'.repeat(32),
      txRoot: 'ef'.repeat(32),
      txs: [],
      hash: '00'.repeat(32),
    };
    const blockRes = await postJson(base, '/block', badBlock);
    assert.equal(blockRes.status, 400);
    const chain = await (await fetch(`${base}/chain`)).json();
    assert.equal(chain.height, 0, '非法区块不得改变主链');
  });
});
