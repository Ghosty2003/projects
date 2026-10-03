import { sealBlock } from './block.js';
import { Chain, type ChainConfig } from './chain.js';
import type { Block } from './types.js';

/** 节点：链 + 交易池 + 本地挖矿。 */
export class Node {
  readonly chain: Chain;

  constructor(config: ChainConfig) {
    this.chain = new Chain(config);
  }

  /** 从交易池挑选交易，在当前主链顶端挖矿并接入。返回接入后的区块。 */
  mine(maxTxs = 1000): Block {
    const tip = this.chain.tip();
    const txs = this.chain.pool.pickForBlock(tip.state, maxTxs);
    const draft = this.chain.assembleBlock(tip.block.hash, txs, Date.now());
    const sealed = sealBlock(draft);
    const result = this.chain.addBlock(sealed);
    if (result.status !== 'main' && result.status !== 'reorg') {
      throw new Error(`freshly mined block rejected: ${result.status} ${result.reason ?? ''}`);
    }
    return sealed;
  }
}
