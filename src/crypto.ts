import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import type { Transaction } from './types.js';

export function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 键序无关的规范化 JSON，保证哈希确定性 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  };
}

export function addressOf(publicKeyHex: string): string {
  return sha256hex(Buffer.from(publicKeyHex, 'hex'));
}

export interface UnsignedTx {
  from: string;
  to: string;
  amount: number;
  nonce: number;
}

export function txSigningPayload(tx: UnsignedTx): string {
  return canonical({ from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce });
}

export function signPayload(payload: string, privateKeyHex: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyHex, 'hex'), format: 'der', type: 'pkcs8' });
  return cryptoSign(null, Buffer.from(payload, 'utf8'), key).toString('hex');
}

export function verifyPayload(payload: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

export function signTx(unsigned: UnsignedTx, privateKeyHex: string, publicKeyHex: string): Transaction {
  return {
    ...unsigned,
    publicKey: publicKeyHex,
    signature: signPayload(txSigningPayload(unsigned), privateKeyHex),
  };
}

export function verifyTxSignature(tx: Transaction): boolean {
  if (typeof tx.publicKey !== 'string' || typeof tx.signature !== 'string') return false;
  if (addressOf(tx.publicKey) !== tx.from) return false;
  return verifyPayload(txSigningPayload(tx), tx.signature, tx.publicKey);
}

export function txHash(tx: Transaction): string {
  return sha256hex(canonical(tx));
}
