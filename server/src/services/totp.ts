import * as OTPAuth from 'otpauth';
export function makeTotp(email: string, secret?: string) {
  return new OTPAuth.TOTP({ issuer: 'CUSA Identity', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: secret ? OTPAuth.Secret.fromBase32(secret) : new OTPAuth.Secret({ size: 20 }) });
}
export function totpStep(email: string, secret: string, code: string, now = Date.now()): number | null {
  const delta = makeTotp(email, secret).validate({ token: code, window: 1, timestamp: now });
  return delta === null ? null : Math.floor(now / 30000) + delta;
}
