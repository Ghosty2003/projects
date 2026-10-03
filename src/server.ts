import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { verifyProof } from './merkle.js';
import { txHash } from './transaction.js';
import type { Node } from './node.js';
import type { Block, InclusionProof, Transaction } from './types.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createApp(node: Node): Server {
  const chain = node.chain;

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      // GET / —— 节点信息
      if (method === 'GET' && parts.length === 0) {
        const tip = chain.tip();
        return send(res, 200, {
          name: 'mini-chain',
          height: tip.block.height,
          tip: tip.block.hash,
          cumDifficulty: tip.cumDifficulty.toString(),
          difficulty: chain.difficulty,
          poolSize: chain.pool.size,
        });
      }

      // GET /chain —— 主链概览
      if (method === 'GET' && parts[0] === 'chain' && parts.length === 1) {
        const tip = chain.tip();
        const blocks = chain.mainChainHashes().map((hash) => {
          const stored = chain.getBlock(hash)!;
          return {
            height: stored.block.height,
            hash,
            prevHash: stored.block.prevHash,
            stateRoot: stored.block.stateRoot,
            txCount: stored.block.txs.length,
          };
        });
        return send(res, 200, {
          height: tip.block.height,
          tip: tip.block.hash,
          cumDifficulty: tip.cumDifficulty.toString(),
          blocks,
        });
      }

      // GET /blocks/:hash —— 区块详情
      if (method === 'GET' && parts[0] === 'blocks' && parts.length === 2) {
        const stored = chain.getBlock(parts[1]!);
        if (!stored) throw new HttpError(404, 'block not found');
        const onMain = chain.mainChainHashes().includes(parts[1]!);
        return send(res, 200, {
          block: stored.block,
          cumDifficulty: stored.cumDifficulty.toString(),
          onMainChain: onMain,
        });
      }

      // POST /blocks —— 提交新区块（含分叉块）
      if (method === 'POST' && parts[0] === 'blocks' && parts.length === 1) {
        const body = (await readJson(req)) as Block;
        const result = chain.addBlock(body);
        const status =
          result.status === 'invalid' ? 400 :
          result.status === 'orphan' ? 404 : 200;
        return send(res, status, result);
      }

      // POST /mine —— 在本地打包交易池并挖矿
      if (method === 'POST' && parts[0] === 'mine' && parts.length === 1) {
        const body = (await readJson(req).catch(() => ({}))) as { maxTxs?: number };
        const block = node.mine(body.maxTxs ?? 1000);
        return send(res, 201, { block });
      }

      // POST /transactions —— 提交交易到交易池
      if (method === 'POST' && parts[0] === 'transactions' && parts.length === 1) {
        const tx = (await readJson(req)) as Transaction;
        try {
          chain.pool.add(tx, chain.tip().state);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        return send(res, 201, { hash: txHash(tx) });
      }

      // GET /pool —— 交易池内容
      if (method === 'GET' && parts[0] === 'pool' && parts.length === 1) {
        return send(res, 200, { txs: chain.pool.list() });
      }

      // GET /accounts/:address —— 主链顶端账户状态
      if (method === 'GET' && parts[0] === 'accounts' && parts.length === 2) {
        const address = parts[1]!;
        const account = chain.tip().state.get(address);
        return send(res, 200, { address, ...account, block: chain.tip().block.hash });
      }

      // GET /accounts/:address/proof?block=<hash> —— 余额包含证明
      if (method === 'GET' && parts[0] === 'accounts' && parts[2] === 'proof' && parts.length === 3) {
        const address = parts[1]!;
        const blockHash = url.searchParams.get('block') ?? chain.tip().block.hash;
        const state = chain.stateAt(blockHash);
        if (!state) throw new HttpError(404, 'unknown block');
        const found = state.prove(address);
        if (!found) throw new HttpError(404, 'account not found in state at that block');
        const proof: InclusionProof = {
          root: state.root(),
          address,
          account: found.account,
          proof: found.proof,
        };
        return send(res, 200, proof);
      }

      // POST /proofs/verify —— 独立校验包含证明（不依赖节点状态）
      if (method === 'POST' && parts[0] === 'proofs' && parts[1] === 'verify' && parts.length === 2) {
        const body = (await readJson(req)) as Partial<InclusionProof>;
        if (
          typeof body.root !== 'string' ||
          typeof body.address !== 'string' ||
          typeof body.account !== 'object' || body.account === null ||
          !Array.isArray(body.proof)
        ) {
          throw new HttpError(400, 'malformed proof request');
        }
        const valid = verifyProof(body.root, body.address, body.account, body.proof);
        return send(res, 200, { valid });
      }

      throw new HttpError(404, 'not found');
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message });
      } else {
        send(res, 500, { error: (err as Error).message });
      }
    }
  });
}
