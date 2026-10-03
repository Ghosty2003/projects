import { generateKeyPair } from './crypto.js';
import { Node } from './node.js';
import { createApp } from './server.js';

const PORT = Number(process.env.PORT ?? 3000);
const DIFFICULTY = Number(process.env.DIFFICULTY ?? 12);

// 演示用账户：私钥打印到控制台，便于手工构造交易
const alice = generateKeyPair();
const bob = generateKeyPair();

const node = new Node({
  difficulty: DIFFICULTY,
  alloc: [
    { address: alice.address, balance: 1_000_000 },
    { address: bob.address, balance: 500_000 },
  ],
});

console.log('demo accounts (private keys are local-only, do not reuse):');
console.log('  alice:', JSON.stringify(alice, null, 2));
console.log('  bob:  ', JSON.stringify(bob, null, 2));

const server = createApp(node);
server.listen(PORT, () => {
  console.log(`mini-chain node listening on http://localhost:${PORT} (difficulty=${DIFFICULTY} bits)`);
});
