import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';

export function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 确定性 JSON 序列化：对象键按字典序排序，数组保持顺序。
 * 用于交易签名载荷与区块哈希，保证全网对同一对象得到同一字节串。
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
  }
  throw new Error('unsupported value in canonical encoding');
}

export interface KeyPair {
  /** spki DER hex，可直接放进交易 */
  publicKeyHex: string;
  /** pkcs8 DER hex，仅本地持有 */
  privateKeyHex: string;
  /** 地址 = sha256(公钥) 的 hex */
  address: string;
}

export function addressOf(publicKeyHex: string): string {
  return sha256hex(Buffer.from(publicKeyHex, 'hex'));
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
  const privateKeyHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
  return { publicKeyHex, privateKeyHex, address: addressOf(publicKeyHex) };
}

export function signMessage(privateKeyHex: string, message: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyHex, 'hex'), format: 'der', type: 'pkcs8' });
  return edSign(null, Buffer.from(message, 'utf8'), key).toString('hex');
}

export function verifyMessage(publicKeyHex: string, message: string, signatureHex: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
