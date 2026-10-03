import { canonical, sha256hex, signMessage, verifyMessage, addressOf, type KeyPair } from './crypto.js';
import type { Transaction } from './types.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** 签名载荷：只覆盖业务字段，不含公钥与签名本身。 */
export function txSigningPayload(tx: Pick<Transaction, 'from' | 'to' | 'amount' | 'nonce'>): string {
  return canonical({ from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce });
}

export function txHash(tx: Transaction): string {
  return sha256hex(canonical(tx));
}

export function isValidTxShape(tx: unknown): tx is Transaction {
  if (typeof tx !== 'object' || tx === null) return false;
  const t = tx as Record<string, unknown>;
  return (
    typeof t.from === 'string' && HEX64.test(t.from) &&
    typeof t.to === 'string' && HEX64.test(t.to) &&
    typeof t.amount === 'number' && Number.isSafeInteger(t.amount) && t.amount > 0 &&
    typeof t.nonce === 'number' && Number.isSafeInteger(t.nonce) && t.nonce >= 0 &&
    typeof t.publicKey === 'string' && /^[0-9a-f]+$/.test(t.publicKey) &&
    typeof t.signature === 'string' && /^[0-9a-f]+$/.test(t.signature)
  );
}

/** 校验交易形状、from 与公钥匹配、签名有效。 */
export function verifyTx(tx: unknown): tx is Transaction {
  if (!isValidTxShape(tx)) return false;
  if (addressOf(tx.publicKey) !== tx.from) return false;
  return verifyMessage(tx.publicKey, txSigningPayload(tx), tx.signature);
}

export function signTx(kp: KeyPair, to: string, amount: number, nonce: number): Transaction {
  const base = { from: kp.address, to, amount, nonce };
  return {
    ...base,
    publicKey: kp.publicKeyHex,
    signature: signMessage(kp.privateKeyHex, txSigningPayload(base)),
  };
}
