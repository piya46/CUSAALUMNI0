import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight, Check, CheckCircle2, Copy, LoaderCircle, ShieldCheck, X } from 'lucide-react';

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'compact' : ''}`}><span className="brand-mark"><img src="/cusa-sso.svg" width="36" height="36" alt="" /></span><strong>CUSA SSO</strong></div>;
}
export function Badge({ children, tone = 'green' }: { children: ReactNode; tone?: 'green' | 'gray' | 'amber' | 'blue' | 'red' }) {
  return <span className={`badge ${tone}`}><i />{children}</span>;
}
export function Spinner({ label = 'กำลังโหลดข้อมูล…' }: { label?: string }) { return <div className="loading-state"><LoaderCircle size={24} className="spin" /><span>{label}</span></div>; }
export function Empty({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) { return <div className="empty-state"><ShieldCheck size={34} strokeWidth={1.3} /><h3>{title}</h3><p>{detail}</p>{children}</div>; }
export function Avatar({ name, index = 0, small = false }: { name: string; index?: number; small?: boolean }) {
  const initials = /[ก-๙]/.test(name) ? name.slice(0, 1) : name.split(/\s/).map(n => n[0]).slice(0, 2).join('');
  return <span className={`avatar color-${index % 5} ${small ? 'small' : ''}`}>{initials.toUpperCase()}</span>;
}
export function SectionHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) { return <div className="section-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div><div className="heading-actions">{children}</div></div>; }
export function Panel({ title, subtitle, action, children, className = '' }: { title?: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string }) { return <section className={`panel ${className}`}>{title && <div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>}{children}</section>; }
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) { return <button className="text-link" onClick={onClick}>{children}<ArrowUpRight size={15} /></button>; }
export function Modal({ title, description, children, close, busy = false }: { title: string; description?: string; children: ReactNode; close: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      const dialogs=document.querySelectorAll('[role="dialog"]');
      if(dialogs[dialogs.length-1]!==ref.current)return;
      if (event.key === 'Escape' && !busy) close();
      if (event.key !== 'Tab') return;
      const focusable = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]');
      if (!focusable?.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, [busy, close]);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) close(); }}><div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1}><button className="icon-button modal-close" aria-label="ปิดหน้าต่าง" disabled={busy} onClick={close}><X size={19} /></button><div className="modal-header"><span className="modal-icon"><ShieldCheck size={24} /></span><h2 id="modal-title">{title}</h2>{description && <p>{description}</p>}</div>{children}</div></div>;
}
export function CopyButton({ value, label = 'คัดลอก', copied, onCopy }: { value: string; label?: string; copied: string | null; onCopy: (value: string) => void }) { const done = value === copied; return <button className="copy-button" aria-label={label} type="button" onClick={() => onCopy(value)}>{done ? <Check size={15} /> : <Copy size={15} />}<span>{done ? 'คัดลอกแล้ว' : label}</span></button>; }
export function Toast({ message, error, close }: { message: string; error: boolean; close: () => void }) { return <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{error ? <X size={18} /> : <CheckCircle2 size={18} />}<span>{message}</span><button onClick={close} aria-label="ปิดข้อความ"><X size={15} /></button></div>; }
export const date = (value?: string | null, includeTime = false) => value ? new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }) }).format(new Date(value)) : '—';
export function relative(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  return minutes < 1 ? 'เมื่อสักครู่' : minutes < 60 ? `${minutes} นาทีที่แล้ว` : minutes < 1440 ? `${Math.floor(minutes / 60)} ชั่วโมงที่แล้ว` : date(value);
}
export function eventLabel(event: string) {
  const names: Record<string, string> = { 'auth.login': 'เข้าสู่ระบบสำเร็จ', 'auth.mfa_verified': 'ยืนยันตัวตนด้วย 2FA', 'auth.otp_verified': 'ยืนยัน Email OTP', 'allowlist.created': 'เพิ่มอีเมลที่อนุญาต', 'allowlist.deleted': 'ลบอีเมลที่อนุญาต', 'api_key.created': 'สร้าง API key', 'api_key.revoked': 'เพิกถอน API key', 'application.created': 'เพิ่มแอปพลิเคชัน', 'application.revoked': 'เพิกถอนแอปพลิเคชัน', 'user.deleted': 'ลบสิทธิ์ผู้ใช้', 'session.revoked': 'ยกเลิกเซสชัน', 'totp.enabled': 'เปิด Authenticator', 'totp.disabled': 'ปิด Authenticator' };
  return names[event] || event;
}
