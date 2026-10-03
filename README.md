# mini-chain

简化账户模型的区块链节点内核。TypeScript / Node 20，**仅用内置模块**（`node:crypto`、`node:http`、`node:test`），无 Docker、无 P2P，区块通过 HTTP 接口提交。

## 运行

```bash
npm install
npm start          # 编译并监听 3000 端口（PORT / DIFFICULTY 环境变量可调）
npm test           # 编译并运行全部测试（node:test）
```

启动时会生成两个演示账户（alice / bob）并把公私钥打印到控制台，创世分配各 1,000,000 / 500,000。

## 设计要点

- **交易**：`{from, to, amount, nonce, publicKey, signature}`。地址 = `sha256(公钥)` 的 hex；签名是对 `canonical({from,to,amount,nonce})`（键排序的确定性 JSON）的 ed25519 签名。
- **区块验证**：形状 → 父块存在 → 高度连续 → 难度参数一致 → 哈希与内容一致 → PoW（哈希前 `difficulty` 比特为 0）→ 逐笔校验签名 / nonce 连续 / 余额充足 → 重放后的状态根与区块声明一致。**任何一步失败整块拒绝**：状态全程在父状态的克隆上应用，失败即丢弃，链上无任何残留。
- **分叉与重组**：所有区块按哈希保存；累计难度（每块 `2^difficulty`）最大者为主链，相等则先见为主。重组时直接切换到目标分叉的状态快照（每个区块都保存了应用后的不可变状态），随后维护交易池：移除新主链已包含的交易、清理失效交易、把被回滚区块中**在新主链上仍合法**的交易回流池中，已失效（nonce 被占用 / 余额不足）的丢弃。
- **状态根**：账户按地址字典序排列后构建 Merkle 树（叶子 `sha256('leaf:'+canonical)`，内部节点 `sha256('node:'+左+右)`，奇数节点复制自身）。根只取决于账户集合内容，与插入顺序无关；同一状态内容在任何高度、任何重组前后都得到同一个根。
- **包含证明**：`{root, address, account, proof: [{position, hash}...]}`，校验是纯函数，不依赖节点状态。

## HTTP 接口（默认 `http://localhost:3000`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 节点信息：高度、tip、累计难度、交易池大小 |
| GET | `/chain` | 主链概览（每个区块的高度 / 哈希 / 状态根 / 交易数） |
| GET | `/blocks/:hash` | 区块详情（含是否位于主链） |
| POST | `/blocks` | 提交区块。返回 `{status}`：`main`（延长主链）/ `side`（侧链）/ `reorg`（触发重组）/ `orphan`（父块未知，404）/ `invalid`（非法，400，无残留）/ `known` |
| POST | `/mine` | 从交易池打包并在本地挖矿，body 可选 `{"maxTxs": n}` |
| POST | `/transactions` | 提交交易到交易池（校验签名、nonce 连续、余额充足） |
| GET | `/pool` | 交易池内容 |
| GET | `/accounts/:address` | 主链顶端的余额与 nonce |
| GET | `/accounts/:address/proof?block=<hash>` | 该账户相对指定区块（缺省为主链顶端）状态根的包含证明 |
| POST | `/proofs/verify` | 独立校验包含证明，body 为证明对象，返回 `{valid: bool}` |

### 示例

```bash
# 提交交易（字段来自启动时打印的演示密钥；签名需离线构造，见 src/transaction.ts 的 signTx）
curl -X POST localhost:3000/transactions -H 'content-type: application/json' -d '{"from":"...","to":"...","amount":100,"nonce":0,"publicKey":"...","signature":"..."}'

# 挖矿打包
curl -X POST localhost:3000/mine -H 'content-type: application/json' -d '{}'

# 查询余额与证明
curl localhost:3000/accounts/<address>
curl "localhost:3000/accounts/<address>/proof?block=<blockHash>"

# 校验证明（篡改任意字段都会得到 valid:false）
curl -X POST localhost:3000/proofs/verify -H 'content-type: application/json' -d '<证明JSON>'
```

## 代码结构

```
src/
  crypto.ts       sha256、canonical JSON、ed25519 密钥/签名
  types.ts        交易、区块、账户、证明的类型
  transaction.ts  交易构造、签名与校验
  block.ts        区块哈希、PoW 校验与挖矿
  merkle.ts       账户 Merkle 树：状态根、证明生成与独立校验
  state.ts        账户状态表：转账应用、克隆、状态根、证明
  txpool.ts       交易池：入池校验、打包选择、失效清理
  chain.ts        区块链：区块验证、累计难度主链选择、重组与交易池回流
  node.ts         节点：链 + 本地挖矿
  server.ts       HTTP+JSON 接口
  index.ts        入口（监听 3000）
test/             node:test 测试（31 个用例）
```

## 测试覆盖

- **深层重组**：6 块主链被从创世分出的 7 块分叉替换，账户状态完整切换
- **双花**：池内同 nonce 拒绝、块内同 nonce 整块拒绝、跨分叉双花重组后只有主链生效
- **交易池回流**：被回滚的合法交易回池并可重新上链；nonce 被占用的失效交易丢弃；已包含在新主链的不回流
- **非法区块无残留**：坏签名 / nonce 跳变 / 余额不足 / 累计超支 / 状态根篡改 / 哈希不符 / PoW 不足 / 难度不符 / 高度跳变 / 伪造 from——每种都验证链尖、状态根、交易池完全不变
- **状态证明**：插入顺序无关、重组前后同高度根确定、篡改余额 / nonce / 地址 / 路径 / 根均校验失败
- **API 端到端**：交易 → 挖矿 → 余额 → 证明 → 独立校验全流程
