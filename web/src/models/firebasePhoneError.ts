const configurationMessage = 'บริการยืนยันเบอร์ยังไม่พร้อม กรุณาติดต่อผู้ดูแลพร้อมรหัสข้อผิดพลาด';
const captchaMessage = 'ยืนยัน reCAPTCHA ไม่สำเร็จ กรุณาลองใหม่เมื่อครบเวลารอ';

// Only expose known SDK codes. Provider messages/customData may contain identifiers or tokens.
const messages: Record<string, string> = {
  'auth/configuration-not-found': configurationMessage,
  'auth/invalid-api-key': configurationMessage,
  'auth/invalid-app-id': configurationMessage,
  'auth/app-not-authorized': configurationMessage,
  'auth/unauthorized-domain': configurationMessage,
  'auth/operation-not-allowed': configurationMessage,
  'auth/billing-not-enabled': configurationMessage,
  'auth/recaptcha-not-enabled': configurationMessage,
  'auth/quota-exceeded': 'บริการส่ง SMS ถึงขีดจำกัดชั่วคราว กรุณาลองภายหลังหรือติดต่อผู้ดูแล',
  'auth/too-many-requests': 'ขอรหัสบ่อยเกินไป กรุณารอก่อนลองใหม่ หากยังไม่สำเร็จให้ติดต่อผู้ดูแล',
  'auth/network-request-failed': 'เชื่อมต่อบริการยืนยันเบอร์ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
  'auth/captcha-check-failed': captchaMessage,
  'auth/invalid-app-credential': captchaMessage,
  'auth/missing-app-credential': captchaMessage,
  'auth/invalid-recaptcha-token': captchaMessage,
  'auth/invalid-phone-number': 'กรุณาตรวจสอบเบอร์มือถือพร้อมรหัสประเทศ เช่น +66812345678',
  'auth/missing-phone-number': 'กรุณากรอกเบอร์มือถือพร้อมรหัสประเทศ',
  'auth/invalid-verification-code': 'รหัส SMS ไม่ถูกต้อง กรุณาตรวจสอบแล้วกรอกใหม่',
  'auth/code-expired': 'รหัส SMS หมดอายุ กรุณาขอรหัสใหม่เมื่อครบเวลารอ',
  'auth/session-expired': 'คำขอยืนยันเบอร์หมดอายุ กรุณาขอรหัสใหม่เมื่อครบเวลารอ',
  'auth/invalid-verification-id': 'คำขอยืนยันเบอร์ใช้ไม่ได้ กรุณาขอรหัสใหม่เมื่อครบเวลารอ',
  'auth/internal-error': 'บริการยืนยันเบอร์ขัดข้อง กรุณาลองภายหลังหรือติดต่อผู้ดูแล',
};

export function firebasePhoneError(error: unknown, phase: 'send' | 'verify'): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && Object.hasOwn(messages, code)) return `${messages[code]} (รหัส: ${code})`;
  return phase === 'send'
    ? 'ส่ง SMS ไม่สำเร็จ กรุณาตรวจสอบเบอร์และ reCAPTCHA หรือติดต่อผู้ดูแล'
    : 'ยืนยันเบอร์ไม่สำเร็จ กรุณาลองอีกครั้งหรือติดต่อผู้ดูแล';
}
