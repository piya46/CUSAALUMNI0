import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { config } from '../config.js';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
function pepper() { if (config.sessionSecret.length<32) throw new Error('SESSION_SECRET is not configured'); return config.sessionSecret; }
// Indexed high-entropy credentials use a keyed digest. OTPs additionally use Argon2id below.
export const hashToken = (value: string) => createHmac('sha256',pepper()).update(`cusa:token:v1:${value}`).digest('hex');
export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
const otpInput = (sessionId: string,code: string) => createHmac('sha256',pepper()).update(`cusa:otp:v1:${sessionId}:${code}`).digest('hex');
export async function otpHash(sessionId: string, code: string) { return hash(otpInput(sessionId,code),{algorithm:Algorithm.Argon2id,memoryCost:19456,timeCost:2,parallelism:1}); }
export async function verifyOtpHash(encoded: string,sessionId: string,code: string) { return verify(encoded,otpInput(sessionId,code)); }
function key() {
  const bytes = Buffer.from(config.encryptionKey, 'base64');
  if (bytes.length !== 32) throw new Error('ENCRYPTION_KEY is not configured');
  return bytes;
}
export function seal(value: string) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.');
}
export function unseal(value: string) {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted value');
  const [iv, tag, content] = parts.map(p => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8');
}
