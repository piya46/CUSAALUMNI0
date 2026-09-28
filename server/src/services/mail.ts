import { JWT, OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';

export async function sendOtp(email: string, code: string) {
  if (!config.mailConfigured) throw new Error('Mail provider is not configured');
  if (/[\r\n]/.test(email)) throw new Error('Invalid mail recipient');
  const client = config.mailMode === 'workspace_service_account'
    ? new JWT({ email: config.googleServiceAccountEmail, key: config.googleServiceAccountPrivateKey, subject: config.gmailSender, scopes: ['https://www.googleapis.com/auth/gmail.send'] })
    : new OAuth2Client(config.gmailClientId, config.gmailClientSecret);
  if (client instanceof OAuth2Client && !(client instanceof JWT)) client.setCredentials({ refresh_token: config.gmailRefreshToken });
  const message = [
    `From: CUSA Identity <${config.gmailSender}>`, `To: ${email}`, 'Subject: Your CUSA Identity verification code',
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '',
    `Your verification code is: ${code}`, '', `It expires in ${config.otpMinutes} minutes and can be used once.`,
    'If you did not request this sign-in, you can ignore this email. Never share this code.',
  ].join('\r\n');
  await client.request({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', method: 'POST', data: { raw: Buffer.from(message).toString('base64url') }, timeout: 15000 });
}
