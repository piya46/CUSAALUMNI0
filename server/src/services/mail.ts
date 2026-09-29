import { randomUUID } from 'node:crypto';
import { JWT, OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';

export async function sendOtp(email: string, code: string, reference: string, applicationName?:string|null) {
  if (!config.mailConfigured) throw new Error('Mail provider is not configured');
  if (/[\r\n]/.test(email)) throw new Error('Invalid mail recipient');
  const client = config.mailMode === 'workspace_service_account'
    ? new JWT({ email: config.googleServiceAccountEmail, key: config.googleServiceAccountPrivateKey, subject: config.gmailSender, scopes: ['https://www.googleapis.com/auth/gmail.send'] })
    : new OAuth2Client(config.gmailClientId, config.gmailClientSecret);
  if (client instanceof OAuth2Client && !(client instanceof JWT)) client.setCredentials({ refresh_token: config.gmailRefreshToken });
  const message = buildOtpMessage(email,code,reference,applicationName);
  await client.request({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', method: 'POST', data: { raw: Buffer.from(message).toString('base64url') }, timeout: 15000 });
}

const encodePart = (value:string) => Buffer.from(value,'utf8').toString('base64').match(/.{1,76}/g)!.join('\r\n');
export function renderOtpEmail(code:string,reference:string,applicationName?:string|null) {
  if(!/^\d{6}$/.test(code)||!/^[A-F0-9]{8}$/.test(reference)) throw new Error('Invalid OTP mail data');
  const purpose=applicationName?`ยืนยันการเข้าสู่ระบบ CUSA SSO เพื่อเข้าใช้งาน ${applicationName}`:'ยืนยันการเข้าสู่ระบบ CUSA SSO';
  const escapedPurpose=purpose.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
  const text=`CUSA SSO\nวัตถุประสงค์: ${purpose}\n\nรหัส OTP: ${code}\nRef: ${reference}\n\nรหัสมีอายุ ${config.otpMinutes} นาที และใช้ได้ครั้งเดียว\nตรวจสอบว่า Ref ตรงกับหน้าเข้าสู่ระบบก่อนกรอกรหัส\n\nห้ามส่งต่อรหัสนี้ ทีมงานจะไม่ขอรหัส OTP จากคุณ\nหากไม่ได้ขอเข้าสู่ระบบ คุณสามารถละเว้นอีเมลนี้ได้\n\nสมาคมนิสิตเก่าวิทยาศาสตร์ จุฬาลงกรณ์มหาวิทยาลัย\nsupport.scicualumni@gmail.com`;
  const html=`<!doctype html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CUSA SSO — รหัสยืนยัน</title></head>
<body style="margin:0;background:#f3f6f2;color:#233d31;font-family:Tahoma,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">รหัสยืนยันสำหรับ CUSA SSO · Ref ${reference} · มีอายุ ${config.otpMinutes} นาที</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6f2"><tr><td align="center" style="padding:36px 16px">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:100%;max-width:480px">
<tr><td style="padding:0 0 24px;text-align:center;font-size:24px;font-weight:700;letter-spacing:1px;color:#315f49">CUSA SSO</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e0e8dc;border-radius:16px;padding:32px 24px;text-align:center">
<p style="margin:0 0 12px;font-size:12px;letter-spacing:2px;color:#6a816b">ยืนยันการเข้าสู่ระบบ</p>
<h1 style="font-size:23px;line-height:1.5;margin:0 0 12px">รหัสยืนยันของคุณ</h1>
<p style="font-size:14px;line-height:1.8;color:#6d796f;margin:0 0 24px">กรอกรหัสด้านล่างที่หน้า CUSA SSO<br>เพื่อดำเนินการเข้าสู่ระบบต่อ</p><p style="margin:0 0 24px;font-size:13px;line-height:1.8;color:#38583d"><strong>วัตถุประสงค์</strong><br>${escapedPurpose}</p>
<div style="background:#f0f5eb;border:1px solid #e0e9d8;border-radius:12px;padding:22px 8px">
<div style="font-family:Consolas,monospace;font-size:36px;font-weight:bold;letter-spacing:7px;color:#264b35">${code}</div>
<p style="font-family:Consolas,monospace;font-size:13px;color:#64765b;margin:12px 0 0">Ref: <strong>${reference}</strong></p></div>
<p style="margin:20px 0 0;font-size:13px;line-height:1.9;color:#64745e">รหัสมีอายุ <strong>${config.otpMinutes} นาที</strong> และใช้ได้ครั้งเดียว<br>ตรวจสอบว่า Ref ตรงกับหน้าเข้าสู่ระบบ</p>
<div style="border-top:1px solid #edf0e9;margin-top:24px;padding-top:20px;font-size:12px;line-height:1.9;color:#7d8578"><strong>ห้ามส่งต่อรหัสนี้ให้ผู้อื่น</strong><br>ทีมงานจะไม่ขอรหัส OTP จากคุณ<br>หากไม่ได้ขอเข้าสู่ระบบ คุณสามารถละเว้นอีเมลนี้ได้</div>
</td></tr><tr><td style="padding:24px 12px;text-align:center;font-size:11px;line-height:1.9;color:#8a9584">สมาคมนิสิตเก่าวิทยาศาสตร์ จุฬาลงกรณ์มหาวิทยาลัย<br><a href="mailto:support.scicualumni@gmail.com" style="color:#607850">support.scicualumni@gmail.com</a></td></tr>
</table></td></tr></table></body></html>`;
  return {text,html};
}
export function buildOtpMessage(email:string,code:string,reference:string,applicationName?:string|null) {
  if(/[\r\n]/.test(email)||/[\r\n]/.test(config.gmailSender)) throw new Error('Invalid mail address');
  const {text,html}=renderOtpEmail(code,reference,applicationName); const boundary=`cusa_${randomUUID()}`;
  return [`From: CUSA SSO <${config.gmailSender}>`,`To: ${email}`,'Subject: CUSA SSO verification code','MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,'',
    `--${boundary}`,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',encodePart(text),
    `--${boundary}`,'Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: base64','',encodePart(html),`--${boundary}--`,''].join('\r\n');
}
