import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { verifyStateProof } from './merkle.js';
import type { Node } from './node.js';
import type { Block, Transaction } from './types.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

interface ProofVerifyBody {
  root: string;
  address: string;
  account: { balance: number; nonce: number };
  proof: { hash: string; position: 'left' | 'right' }[];
}

export function createHttpServer(node: Node): Server {
  return createServer((req, res) => {
    handle(node, req, res).catch((err: unknown) => {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handle(node: Node, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/chain') {
    sendJson(res, 200, {
      height: node.chain.tip.height,
      tip: node.chain.tip.hash,
      stateRoot: node.chain.tip.stateRoot,
      cumulativeWork: node.chain.cumulativeWork.toString(),
      difficulty: node.chain.difficulty,
    });
    return;
  }

  if (method === 'GET' && path === '/mempool') {
    sendJson(res, 200, { txs: node.mempool.list() });
    return;
  }

  if (method === 'GET' && path === '/accounts') {
    sendJson(res, 200, { accounts: Object.fromEntries(node.chain.stateAt(node.chain.tip.hash)!.entries()) });
    return;
  }

  if (method === 'GET' && path.startsWith('/balance/')) {
    const address = decodeURIComponent(path.slice('/balance/'.length));
    sendJson(res, 200, { address, ...node.balanceOf(address) });
    return;
  }

  if (method === 'GET' && path.startsWith('/block/')) {
    const hash = path.slice('/block/'.length);
    const block = node.chain.get(hash);
    if (!block) {
      sendJson(res, 404, { error: 'unknown block' });
      return;
    }
    sendJson(res, 200, block);
    return;
  }

  if (method === 'GET' && path.startsWith('/proof/')) {
    const parts = path.split('/');
    const blockHash = parts[2];
    const address = parts[3];
    if (!blockHash || !address) {
      sendJson(res, 400, { error: 'usage: GET /proof/:blockHash/:address' });
      return;
    }
    sendJson(res, 200, { address, ...node.getProof(blockHash, address) });
    return;
  }

  if (method === 'POST' && path === '/proof/verify') {
    const body = (await readBody(req)) as Partial<ProofVerifyBody>;
    if (
      typeof body.root !== 'string' ||
      typeof body.address !== 'string' ||
      typeof body.account?.balance !== 'number' ||
      typeof body.account?.nonce !== 'number' ||
      !Array.isArray(body.proof)
    ) {
      sendJson(res, 400, { error: 'expected {root, address, account:{balance,nonce}, proof:[]}' });
      return;
    }
    sendJson(res, 200, {
      valid: verifyStateProof(body.root, body.address, body.account, body.proof),
    });
    return;
  }

  if (method === 'POST' && path === '/tx') {
    const tx = (await readBody(req)) as Transaction;
    sendJson(res, 200, { txHash: node.submitTx(tx) });
    return;
  }

  if (method === 'POST' && path === '/mine') {
    const body = (await readBody(req)) as { prevHash?: string; txs?: Transaction[] };
    sendJson(res, 200, node.mine(body.prevHash, body.txs));
    return;
  }

  if (method === 'POST' && path === '/block') {
    const block = (await readBody(req)) as Block;
    sendJson(res, 200, node.submitBlock(block));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
