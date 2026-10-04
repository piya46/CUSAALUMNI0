import { z } from 'zod';

export const claimScopeNames = ['identity:read', 'profile', 'email', 'phone', 'phone:match', 'line', 'assurance'] as const;
export type ClaimScope = typeof claimScopeNames[number];
export const defaultClaimScope = 'identity:read profile email';
export const consentNoticeVersion = '1.0';
export const claimScopeList = z.array(z.enum(claimScopeNames)).min(1).max(claimScopeNames.length)
  .refine(scopes => scopes.includes('identity:read') && new Set(scopes).size === scopes.length,
    'Scopes must be unique and include identity:read');
export const claimScopeString = z.string().max(255).refine(value => claimScopeList.safeParse(value.split(' ')).success,
  'Unknown, duplicate or missing identity:read scope');
export const sharingPolicySchema = z.object({
  scopes: claimScopeList,
  purpose: z.string().trim().min(10).max(500).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
}).strict();
export function scopesWithin(requested: string, allowed: string): boolean {
  return claimScopeString.safeParse(requested).success && claimScopeString.safeParse(allowed).success
    && requested.split(' ').every(scope => allowed.split(' ').includes(scope));
}
export function normalizePhone(value: string): string | null {
  const phone = value.replace(/[๐-๙]/g, digit => String(digit.charCodeAt(0) - 0x0e50)).replace(/[\s()-]/g, '');
  if (/^0[689]\d{8}$/.test(phone)) return `+66${phone.slice(1)}`;
  if (/^66[689]\d{8}$/.test(phone)) return `+${phone}`;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

export const scopeDescriptions: Record<ClaimScope, { title: string; detail: string }> = {
  'identity:read': { title: 'บัญชีและสิทธิ์ใน Service นี้', detail: 'รหัสผู้ใช้ CUSA และ Role เฉพาะ Service นี้ ใช้ระบุบัญชีที่กำลังเข้าสู่ระบบ' },
  profile: { title: 'โปรไฟล์พื้นฐาน', detail: 'ชื่อ ชื่อจริง นามสกุล รูปโปรไฟล์ และหน่วยงานใน Service นี้' },
  email: { title: 'อีเมล', detail: 'อีเมลบัญชีและสถานะการยืนยันจาก Google' },
  phone: { title: 'เบอร์โทรศัพท์', detail: 'เบอร์ที่ยืนยันแล้ว พร้อมสถานะและเวลายืนยันการถือครองเบอร์ ไม่ใช่การยืนยันชื่อเจ้าของซิม' },
  'phone:match': { title: 'ตรวจว่าเบอร์ตรงกัน', detail: 'ให้ Service ตรวจเบอร์ที่คุณกรอกกับเบอร์ที่ยืนยันใน CUSA คืนเฉพาะผลการเปรียบเทียบ ไม่ส่งเบอร์จริงผ่านสิทธิ์นี้' },
  line: { title: 'บัญชี LINE ที่ผูกไว้', detail: 'LINE User ID และสถานะการผูกบัญชี ไม่มี LINE token; UID อาจต่างกันหากระบบลูกใช้คนละ LINE Provider' },
  assurance: { title: 'วิธีและเวลายืนยันตัวตน', detail: 'วิธีที่ใช้ยืนยันครั้งนี้ เวลา และระดับตามนโยบาย CUSA ไม่ใช่ผลตรวจบัตรประชาชนหรือการรับรอง KYC' },
};
