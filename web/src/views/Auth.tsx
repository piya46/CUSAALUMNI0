import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowRight, CircleAlert, Globe2, LockKeyhole, Mail, RefreshCw } from 'lucide-react';
import { api } from '../models/api';
import type { Identity } from '../models/types';
import type { LoginContext } from '../models/login';
import { Brand } from '../components/ui';
import './auth.css';

export interface ServerStatus { configured: boolean; mailConfigured: boolean; googleConfigured: boolean }
function AuthLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return <div className="auth-page"><main className="auth-main"><header className="auth-brand"><Brand /></header><section className="auth-card">{children}</section>{footer}</main><footer className="auth-footer">© {new Date().getFullYear()} CUSA SSO</footer></div>;
}
function ApplicationContext({ context }: { context?: LoginContext | null }) {
  if (!context) return null;
  return <div className="auth-application"><span className="auth-application-icon"><Globe2 size={20} /></span><div><span>เข้าสู่ระบบเพื่อใช้งาน</span><strong>{context.application.name}</strong><small>{context.application.origin}</small></div></div>;
}
function GoogleMark() {
  return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.01v2.5h3.24c1.9-1.75 2.98-4.33 2.98-7.34Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.61-2.43l-3.24-2.5c-.9.6-2.06.97-3.37.97-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.82 1.5l2.86-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"/></svg>;
}
export function Login({ status, checking, context, onDemo, onRetry }: { status: ServerStatus | null; checking: boolean; context: LoginContext | null; onDemo: () => void; onRetry: () => void }) {
  const authError = new URLSearchParams(window.location.search).get('auth') === 'error';
  const href = `/api/auth/google/start${context ? `?${new URLSearchParams({ returnTo: context.returnTo })}` : ''}`;
  return <AuthLayout footer={!context && !status?.configured ? <div className="auth-demo"><button onClick={onDemo}>เปิดโหมดตัวอย่าง <ArrowRight size={14} /></button><p>ทดลองหน้าจอด้วยข้อมูลจำลอง</p></div> : undefined}>
    <ApplicationContext context={context} />
    <h1>เข้าสู่ระบบ</h1><p className="auth-description">ใช้บัญชี Google ของคุณเพื่อดำเนินการต่อ</p>
    {authError && <div className="inline-error" role="alert">เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจสอบว่าอีเมลได้รับอนุญาต แล้วลองอีกครั้ง</div>}
    {status?.configured ? <a className="auth-google" href={href}><GoogleMark />ดำเนินการต่อด้วย Google<ArrowRight size={17} /></a> : <button className="auth-google" disabled><GoogleMark />ดำเนินการต่อด้วย Google<ArrowRight size={17} /></button>}
    <p className="auth-note"><LockKeyhole size={14} /><span>สำหรับอีเมลที่ได้รับอนุญาต<br />ยืนยันอีกขั้นก่อนเข้าใช้งาน</span></p>
    {!status?.configured && <div className="auth-availability" role="status"><span>{checking ? 'กำลังตรวจสอบการเชื่อมต่อ…' : status ? 'ระบบยังไม่พร้อมให้เข้าสู่ระบบ' : 'ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้'}</span><button onClick={onRetry} disabled={checking} aria-label="ตรวจสอบการเชื่อมต่ออีกครั้ง"><RefreshCw size={15} className={checking ? 'spin' : ''} /></button></div>}
    {context && <p className="auth-return-note">เมื่อยืนยันสำเร็จ คุณจะกลับไปยัง {context.application.name}</p>}
  </AuthLayout>;
}
export function LoginRequest({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <AuthLayout><div className="auth-state-icon">{error ? <CircleAlert size={24} /> : <RefreshCw size={24} className="spin" />}</div><h1>{error ? 'ไม่สามารถเข้าสู่ระบบได้' : 'กำลังตรวจสอบคำขอ'}</h1><p className="auth-description" role={error ? 'alert' : 'status'}>{error || 'กรุณารอสักครู่'}</p>{error && <><button className="button secondary full-width" onClick={onRetry}>ลองอีกครั้ง</button><p className="auth-return-note">หากยังเข้าไม่ได้ กรุณาเริ่มใหม่จากแอปที่ต้องการใช้งาน</p><a className="auth-text-button" href="/login">ไปหน้าเข้าสู่ระบบ CUSA SSO</a></>}</AuthLayout>;
}
export function ContinueLogin({ identity, context, denied = false, onLogout }: { identity: Identity; context: LoginContext; denied?: boolean; onLogout: () => Promise<void> }) {
  return <AuthLayout><ApplicationContext context={context} /><h1>{denied ? 'ยังไม่มีสิทธิ์เข้าใช้งาน' : 'พร้อมเข้าใช้งาน'}</h1><p className="auth-description">คุณเข้าสู่ระบบแล้วด้วยบัญชี</p><div className="auth-email">{identity.user.email}</div><>{denied ? <p className="auth-description" role="alert">กรุณาติดต่อผู้ดูแลเพื่อเพิ่มสมาชิกและกำหนด Role ใน Service นี้</p> : <a className="button primary full-width" href={context.returnTo}>ดำเนินการต่อ<ArrowRight size={17} /></a>}</><button className="auth-text-button" onClick={() => void onLogout()}>ใช้บัญชีอื่น</button></AuthLayout>;
}
export function Mfa({ identity, context, onVerified, onLogout }: { identity: Identity; context: LoginContext | null; onVerified: () => Promise<void>; onLogout: () => Promise<void> }) {
  const isTotp = identity.mfaMethod === 'totp';
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [sent, setSent] = useState(false);
  async function send() { setBusy(true); setError(''); try { await api('/auth/otp/send', 'POST', {}); setSent(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function verify(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { await api(`/auth/${recovery ? 'recovery' : isTotp ? 'totp' : 'otp'}/verify`, 'POST', { code }); await onVerified(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <AuthLayout><ApplicationContext context={context} /><p className="auth-step">ขั้นตอนที่ 2 จาก 2</p><h1>ยืนยันว่าเป็นคุณ</h1><p className="auth-description">{recovery ? 'กรอก Recovery code ที่ยังไม่เคยใช้' : isTotp ? 'กรอกรหัส 6 หลักจากแอป Authenticator' : 'รับรหัสยืนยัน 6 หลักผ่านอีเมลของคุณ'}</p><div className="auth-email">{identity.user.email}</div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {!isTotp && <><button className="button secondary full-width" disabled={busy} onClick={send}><Mail size={16} />{sent ? 'ส่งรหัสอีกครั้ง' : 'ส่งรหัสไปยังอีเมล'}</button>{sent && <p className="auth-success" role="status">ส่งรหัสแล้ว กรุณาตรวจสอบกล่องจดหมายและสแปม</p>}</>}
    <form onSubmit={verify}><label className="field">{recovery ? 'Recovery code' : 'รหัสยืนยัน'}<input className={recovery ? '' : 'auth-otp'} inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" pattern={recovery ? undefined : '[0-9]{6}'} maxLength={recovery ? 64 : 6} placeholder={recovery ? 'Recovery code' : '000000'} value={code} onChange={e => setCode(recovery ? e.target.value : e.target.value.replace(/\D/g, ''))} required autoFocus /></label><button className="button primary full-width" disabled={busy || (recovery ? !code.trim() : code.length !== 6)}>{busy ? 'กำลังตรวจสอบ…' : 'ยืนยันและเข้าสู่ระบบ'}<ArrowRight size={16} /></button></form>
    {isTotp && <button className="auth-text-button" disabled={busy} onClick={() => { setRecovery(!recovery); setCode(''); setError(''); }}>{recovery ? 'ใช้รหัสจาก Authenticator' : 'ใช้ Recovery code'}</button>}
    <button className="auth-text-button" onClick={() => void onLogout()} disabled={busy}>ใช้บัญชีอื่น</button><p className="auth-note"><LockKeyhole size={13} />ห้ามแชร์รหัสยืนยันให้ผู้อื่น</p>
  </AuthLayout>;
}
