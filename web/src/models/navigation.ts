import { Activity, BookOpen, Globe2, KeyRound, Layers3, LockKeyhole, Mail, Monitor, ShieldCheck, UserCheck, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Identity, Page } from './types';

export const navGroups = [
  { id: 0, label: 'พื้นที่ทำงาน', description: 'ภาพรวมของระบบ' },
  { id: 1, label: 'ผู้ใช้และสิทธิ์', description: 'จัดการบัญชีและสิทธิ์การเข้าถึง' },
  { id: 2, label: 'แอปและการเชื่อมต่อ', description: 'เชื่อมบริการและตั้งค่าระบบลูก' },
  { id: 3, label: 'ความปลอดภัย', description: 'ดูแลบัญชีและตรวจสอบกิจกรรม' },
];
export const navItems: { page: Page; label: string; description: string; keywords?: string; icon: LucideIcon; group: number; admin?: boolean }[] = [
  { page: 'overview', label: 'ภาพรวม', description: 'สถิติและความเคลื่อนไหวในพื้นที่ทำงาน', icon: Layers3, group: 0, admin: true },
  { page: 'users', label: 'ผู้ใช้งานภายใน', description: 'ข้อมูลบัญชี หน่วยงาน และสิทธิ์ผู้ใช้', icon: Users, group: 1, admin: true },
  { page: 'allowlist', label: 'อีเมลที่อนุญาต', description: 'กำหนดบัญชีที่เข้าใช้งานภายในได้', icon: Mail, group: 1, admin: true },
  { page: 'serviceAccess', label: 'สิทธิ์แต่ละ Service', description: 'สมาชิกและ Role แยกตามบริการ', icon: UserCheck, group: 1, admin: true },
  { page: 'applications', label: 'แอปพลิเคชัน', description: 'เชื่อมต่อแอป ห้องรอคิว และนโยบายข้อมูล', keywords: 'Consent นโยบาย สมาชิก สมัคร คำเชิญ บัญชีไม่ใช้งาน queue registration invitation redirect', icon: Globe2, group: 2, admin: true },
  { page: 'keys', label: 'API keys', description: 'ออกคีย์ กำหนด Scope และเพิกถอนสิทธิ์', icon: KeyRound, group: 2, admin: true },
  { page: 'integration', label: 'คู่มือเชื่อมต่อ API', description: 'ขั้นตอนเชื่อม SSO และตัวอย่าง API', icon: BookOpen, group: 2, admin: true },
  { page: 'security', label: 'ความปลอดภัย', description: 'Authenticator, Passkey, LINE และรหัสกู้คืน', keywords: 'Email OTP MFA TOTP phone เบอร์มือถือ ข้อมูลที่แชร์ Consent recovery', icon: ShieldCheck, group: 3 },
  { page: 'sessions', label: 'เซสชัน', description: 'ตรวจอุปกรณ์และการเข้าสู่ระบบของคุณ', icon: Monitor, group: 3 },
  { page: 'mfaRequests', label: 'คำขอเปลี่ยน MFA', description: 'ตรวจหลักฐานและคำขอกู้คืนบัญชี', icon: LockKeyhole, group: 3, admin: true },
  { page: 'audit', label: 'บันทึกกิจกรรม', description: 'ค้นหาและตรวจสอบรายการย้อนหลัง', icon: Activity, group: 3, admin: true },
];

export function navigationFor(identity: Identity) {
  return navItems.filter(item => (identity.user.role !== 'service' || ['security', 'sessions'].includes(item.page))
    && (!item.admin || (identity.user.role === 'admin' && !identity.adminMfaRequired)));
}
