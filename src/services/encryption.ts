import * as crypto from 'crypto';

export interface EncryptedPayload {
  iv: string;
  data: string;
  hash: string;
}

export interface EncryptionResult {
  payload: EncryptedPayload;
  buffer: Buffer;
  key: Buffer;
}

export function encryptRecord(record: object): EncryptionResult {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(JSON.stringify(record), 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const payload: EncryptedPayload = {
    iv: iv.toString('hex'),
    data: encrypted,
    hash: '',
  };
  const buffer = Buffer.from(JSON.stringify(payload));
  payload.hash = crypto.createHash('sha256').update(buffer).digest('hex');

  return { payload, buffer, key };
}

export function decryptRecord(
  encryptedPayload: EncryptedPayload,
  key: Buffer
): object {
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    key,
    Buffer.from(encryptedPayload.iv, 'hex')
  );
  let decrypted = decipher.update(encryptedPayload.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}
