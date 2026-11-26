import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EnvshareError } from './error.js';

// Include a NUL so even short files are binary under ordinary Git text detection.
const MAGIC = Buffer.from('ENVSHARE1\0', 'ascii');
const NONCE_END = MAGIC.length + 12;
const TAG_SIZE = 16;
const HEADER_END = NONCE_END + TAG_SIZE;
const ALGORITHM = 'aes-256-gcm';
const OPTIONS = { authTagLength: TAG_SIZE };

export function decodeKey(value) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value) {
    throw new EnvshareError('ENVSHARE_KEY は32バイトを標準Base64で表した値にしてください。');
  }
  return bytes;
}

export function isEnvelope(bytes) {
  return bytes.length >= HEADER_END && bytes.subarray(0, MAGIC.length).equals(MAGIC);
}

export function seal(plain, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, nonce, OPTIONS);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}

export function unseal(bytes, key) {
  const invalid = () => new EnvshareError('暗号ファイルを認証できません。鍵とファイルを確認してください。');
  if (!isEnvelope(bytes)) throw invalid();

  const decipher = createDecipheriv(ALGORITHM, key, bytes.subarray(MAGIC.length, NONCE_END), OPTIONS);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(bytes.subarray(NONCE_END, HEADER_END));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(HEADER_END)), decipher.final()]);
  } catch {
    throw invalid();
  }
}
