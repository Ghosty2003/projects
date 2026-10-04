# chain-reorg

简化账户模型的区块链节点内核。TypeScript 实现，Node 20，仅使用内置模块（`node:http` / `node:crypto` / `node:test`），无任何第三方运行时依赖，不使用 Docker，无 P2P 网络——区块通过 HTTP 接口提交。

## 功能

- **区块验证与状态**：交易为带 nonce 的转账，ed25519 签名（内置 `node:crypto`）。区块校验前序哈希、工作量难度（哈希前导零）、交易签名、nonce 连续性、余额充足、交易根与状态根。任何一笔交易非法则整块拒绝，且状态无任何残留。
- **分叉与重组**：节点保存所有已知分支，主链 = 累计难度最大的链。每个区块保存执行后的状态快照，主链切换时直接切换快照，保证回滚/重放正确。被回滚区块中的交易若在新主链上未被包含且仍然合法，自动回到交易池；已失效的（nonce 已被消费、余额不足等）丢弃。
- **状态证明**：状态根为按地址字典序排列的账户默克尔树根，与账户插入顺序无关，重组前后同一高度的状态根确定。提供余额包含证明的生成接口与独立校验接口。

## 运行

```bash
npm install
npm start          # 构建并启动，监听 http://localhost:3000
```

环境变量：

- `PORT`：监听端口，默认 `3000`
- `DIFFICULTY`：最低难度（区块哈希十六进制前导零个数），默认 `3`

## 测试

```bash
npm test           # 构建并运行 node:test 测试
```

覆盖：深层重组、双花（同块与跨块）、交易池回流与失效丢弃、非法区块无残留、状态根与插入顺序无关、重组前后状态根确定、证明被篡改时校验失败、HTTP 接口端到端。

## 数据格式

### 交易 Transaction

```json
{
  "from": "<发送方地址 = sha256(公钥) 的 hex>",
  "to": "<接收方地址>",
  "amount": 10,
  "nonce": 0,
  "publicKey": "<ed25519 公钥，SPKI DER 的 hex>",
  "signature": "<对 {from,to,amount,nonce} 规范化 JSON 的 ed25519 签名，hex>"
}
```

### 区块 Block

```json
{
  "height": 1,
  "prevHash": "<父块哈希>",
  "timestamp": 1700000000000,
  "difficulty": 3,
  "powNonce": 12345,
  "stateRoot": "<执行本块交易后的状态默克尔根>",
  "txRoot": "<交易列表默克尔根>",
  "txs": [ /* Transaction[] */ ],
  "hash": "<区块头哈希，需满足 difficulty 个前导零>"
}
```

单块工作量为 `16^difficulty`，累计难度为链上各块工作量之和。

### 状态证明 StateProof

```json
{
  "root": "<区块状态根>",
  "account": { "balance": 70, "nonce": 1 },
  "proof": [ { "hash": "<兄弟节点哈希>", "position": "left" } ]
}
```

`account` 为 `null` 表示该地址在该区块状态下不存在。校验时由 `{address, balance, nonce}` 计算叶子哈希，沿 `proof` 路径逐层配对哈希，结果等于 `root` 即通过。

## HTTP 接口

所有请求与响应均为 JSON。校验失败返回 `400 {"error": "..."}` 且无副作用。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/chain` | 主链信息：`{height, tip, stateRoot, cumulativeWork, difficulty}` |
| GET | `/block/:hash` | 按哈希查询区块，未知返回 404 |
| GET | `/balance/:address` | 主链顶端状态下某账户的 `{address, balance, nonce}` |
| GET | `/accounts` | 主链顶端全部账户 |
| GET | `/mempool` | 交易池中的交易列表 |
| GET | `/proof/:blockHash/:address` | 某账户相对于某区块状态根的包含证明 `{address, root, account, proof}` |
| POST | `/proof/verify` | 独立校验证明。请求体 `{root, address, account:{balance,nonce}, proof:[]}`，返回 `{valid: true|false}` |
| POST | `/tx` | 提交交易到交易池（校验签名与 nonce 下限），返回 `{txHash}` |
| POST | `/mine` | 组装、挖矿并提交一个区块。可选请求体 `{prevHash, txs}`：默认基于主链顶端并从交易池选取可执行交易；指定 `prevHash` 可构造分叉。返回挖出的区块 |
| POST | `/block` | 提交完整区块。非法区块整块拒绝且无残留；触发重组时被回滚的合法交易自动回流交易池。返回 `{reorged, tip, height}` |

### 示例

```bash
# 查看主链
curl localhost:3000/chain

# 提交交易（body 为签名后的 Transaction）
curl -X POST localhost:3000/tx -H 'content-type: application/json' -d @tx.json

# 挖一个块（打包交易池中可执行的交易）
curl -X POST localhost:3000/mine -H 'content-type: application/json' -d '{}'

# 查询余额证明并独立校验
curl localhost:3000/proof/<blockHash>/<address>
curl -X POST localhost:3000/proof/verify -H 'content-type: application/json' -d '{"root":"...","address":"...","account":{"balance":70,"nonce":1},"proof":[]}'
```

## 代码结构

```
src/
  types.ts    交易 / 区块 / 账户类型
  crypto.ts   sha256、规范化 JSON、ed25519 签名与地址
  merkle.ts   默克尔树、状态根、包含证明生成与独立校验
  state.ts    账户状态机：nonce / 余额校验与交易执行
  chain.ts    区块校验、累计难度、分叉管理与重组
  mempool.ts  交易池：签名校验、按状态重放清理
  node.ts     节点门面：交易提交、挖矿、区块提交、证明
  server.ts   HTTP+JSON 接口
  index.ts    入口（PORT / DIFFICULTY）
test/
  validation.test.ts  区块验证、非法区块无残留、同块双花
  reorg.test.ts        深层重组、状态根确定性
  mempool.test.ts      交易池回流、跨块双花
  proof.test.ts        状态证明与篡改检测
  server.test.ts       HTTP 接口端到端
```
