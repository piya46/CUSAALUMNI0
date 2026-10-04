import { ExtraMfa } from './AdditionalFactors';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ArrowRight, CircleAlert, Globe2, KeyRound, LockKeyhole, Mail, RefreshCw, ShieldCheck, LifeBuoy, Fingerprint, MessageCircle, Smartphone, Check } from 'lucide-react';
import { MfaResetRequest } from './MfaReset';
import { OtpInput } from '../components/OtpInput';
import { api, ApiError } from '../models/api';
import type { Identity, OtpState } from '../models/types';
import type { LoginContext } from '../models/login';
import { AuthLayout } from '../components/AuthLayout';
import './auth.css';
import './auth-methods.css';

export interface ServerStatus { configured: boolean; mailConfigured: boolean; googleConfigured: boolean }
function ApplicationContext({ context }: { context?: LoginContext | null }) {
  if (!context) return null;
  return <div className="auth-application"><span className="auth-application-icon"><Globe2 size={20} /></span><div><span>เข้าสู่ระบบเพื่อใช้งาน</span><strong>{context.application.name}</strong><small>{context.application.origin}</small><small>หลังยืนยันตัวตน คุณจะเห็นรายการข้อมูลและเลือกอนุญาตก่อนส่งให้ Service นี้</small></div></div>;
}
function GoogleMark() {
  return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.01v2.5h3.24c1.9-1.75 2.98-4.33 2.98-7.34Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.61-2.43l-3.24-2.5c-.9.6-2.06.97-3.37.97-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.82 1.5l2.86-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"/></svg>;
}
export function Login({ status, checking, context, onDemo, onRetry }: { status: ServerStatus | null; checking: boolean; context: LoginContext | null; onDemo: () => void; onRetry: () => void }) {
  const authError = new URLSearchParams(window.location.search).get('auth') === 'error';
  const href = `/api/auth/google/start${context ? `?${new URLSearchParams({ returnTo: context.returnTo })}` : ''}`;
  return <AuthLayout footer={!context && !status?.configured ? <div className="auth-demo"><button onClick={onDemo}>เปิดโหมดตัวอย่าง <ArrowRight size={14} /></button><p>ทดลองหน้าจอด้วยข้อมูลจำลอง</p></div> : undefined}>
    <ApplicationContext context={context} />
    <div className="auth-hero-icon"><KeyRound size={30} aria-hidden="true" /></div>
    <p className="auth-eyebrow">ยินดีต้อนรับกลับ</p><h1>เข้าสู่ระบบ</h1><p className="auth-description">ใช้บัญชี Google ของคุณ<br />เพื่อเข้าถึงบริการที่ได้รับสิทธิ์อย่างปลอดภัย</p>
    <p className="auth-legal-note">การดำเนินการต่ออยู่ภายใต้<a href="/terms" target="_blank" rel="noopener noreferrer">ข้อกำหนดการใช้งาน</a> โปรดอ่าน<a href="/privacy" target="_blank" rel="noopener noreferrer">นโยบายความเป็นส่วนตัว</a>ก่อนเข้าสู่ระบบ</p>
    {authError && <div className="inline-error" role="alert">เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจสอบว่าอีเมลได้รับอนุญาต แล้วลองอีกครั้ง</div>}
    {status?.configured ? <a className="auth-google" href={href}><GoogleMark />ดำเนินการต่อด้วย Google<ArrowRight size={17} /></a> : <button className="auth-google" disabled><GoogleMark />ดำเนินการต่อด้วย Google<ArrowRight size={17} /></button>}
    <p className="auth-note"><LockKeyhole size={14} /><span>สำหรับอีเมลที่ได้รับอนุญาต<br />เลือกวิธียืนยันที่ผูกไว้ในขั้นตอนถัดไป</span></p>
    <details className="auth-details"><summary>ใช้ข้อมูลอะไรจาก Google บ้าง?</summary><p>เราใช้ชื่อ อีเมล รูปโปรไฟล์ และรหัสบัญชีเพื่อยืนยันตัวตนและตรวจสิทธิ์ การเข้าสู่ระบบไม่ขอสิทธิ์อ่านกล่องจดหมายของคุณ</p></details>
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
type MfaMethod = 'totp' | 'email' | 'passkey' | 'line' | 'recovery';
export function Mfa({ identity, context, onVerified, onLogout }: { identity: Identity; context: LoginContext | null; onVerified: () => Promise<void>; onLogout: () => Promise<void> }) {
  const hasTotp = identity.user.totpEnabled;
  const isAdmin = identity.user.role === 'admin';
  const [method, setMethod] = useState<MfaMethod>(hasTotp ? 'totp' : 'email');
  const [reset,setReset]=useState(false);
  const resetHeading=useRef<HTMLHeadingElement>(null),challengeHeading=useRef<HTMLHeadingElement>(null),focusChallenge=useRef(false);
  useEffect(()=>{if(reset)resetHeading.current?.focus();},[reset]);
  useEffect(()=>{if(focusChallenge.current){challengeHeading.current?.focus();focusChallenge.current=false;}},[method]);
  const [code,setCode]=useState(''),[busy,setBusy]=useState(false),[alternativeBusy,setAlternativeBusy]=useState(false),[error,setError]=useState(''),[sent,setSent]=useState(Boolean(identity.otp?.reference));
  const [otp,setOtp]=useState<OtpState|undefined>(identity.otp);
  const [deadline,setDeadline]=useState(()=>Date.now()+(identity.otp?.retryAfter??0)*1000);
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),500);return()=>clearInterval(timer);},[]);
  const remaining=Math.max(0,Math.ceil((deadline-now)/1000)),working=busy||alternativeBusy;
  const recommended=hasTotp||identity.factors?.passkey;
  const labels:Record<MfaMethod,string>={totp:'Authenticator',email:'Email OTP',passkey:'Passkey',line:'LINE Number Matching',recovery:'Recovery code'};
  function choose(next:MfaMethod){if(working)return;focusChallenge.current=true;setCode('');setError('');setMethod(next);if(next===method){challengeHeading.current?.focus();focusChallenge.current=false;}}
  function choice(value:MfaMethod,label:string,description:string,Icon:typeof Smartphone){
    return <button className="mfa-method-choice" type="button" key={value} aria-label={`เลือก ${label}`} aria-pressed={method===value} aria-controls="mfa-challenge" disabled={working} onClick={()=>choose(value)}>
      <span className="mfa-choice-top"><Icon size={21} aria-hidden="true"/><span className="mfa-choice-check" aria-hidden="true">{method===value&&<Check size={13}/>}</span></span><strong>{label}</strong><small>{description}</small>
    </button>;
  }
  async function send(){setBusy(true);setError('');try{const next=await api<OtpState>('/auth/otp/send','POST',{});setOtp(next);setDeadline(Date.now()+next.retryAfter*1000);setNow(Date.now());setCode('');setSent(true);}catch(e){setError((e as Error).message);if(e instanceof ApiError&&e.retryAfter){setDeadline(Date.now()+e.retryAfter*1000);setNow(Date.now());}}finally{setBusy(false);}}
  async function verify(event:FormEvent){event.preventDefault();if(!['totp','email','recovery'].includes(method))return;setBusy(true);setError('');try{await api(`/auth/${method==='email'?'otp':method}/verify`,'POST',{code,...(method==='email'?{reference:otp?.reference}:{})});await onVerified();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  if(reset)return <AuthLayout wide><button className="auth-back" onClick={()=>setReset(false)}><ArrowLeft size={16}/>กลับไปยืนยันตัวตน</button><div className="auth-hero-icon"><LifeBuoy size={28}/></div><h1 tabIndex={-1} ref={resetHeading}>ขอรีเซ็ต MFA</h1><p className="auth-description">ให้ผู้ดูแลช่วยกู้การเข้าถึงบัญชีของคุณ</p><div className="auth-email">{identity.user.email}</div><MfaResetRequest/></AuthLayout>;
  return <AuthLayout wide><ApplicationContext context={context}/><p className="auth-step">{context?'ขั้นตอนที่ 2 · ยืนยันตัวตน ก่อนเลือกอนุญาตข้อมูล':'ขั้นตอนที่ 2 จาก 2'}</p><h1>ยืนยันว่าเป็นคุณ</h1><p className="auth-description">เลือกวิธียืนยันที่สะดวกจากบัญชีที่ผูกไว้</p><div className="auth-email">{identity.user.email}</div>
    <div className="mfa-method-groups">
      {recommended&&<section aria-labelledby="mfa-recommended"><div className="mfa-group-heading"><h2 id="mfa-recommended"><ShieldCheck size={16}/>วิธีแนะนำ</h2><span>{isAdmin?'เปิดสิทธิ์ Admin ได้ทันที':'ยืนยันด้วยอุปกรณ์ของคุณ'}</span></div><div className="mfa-method-grid">
        {hasTotp&&choice('totp','Authenticator','รหัส 6 หลักจากแอปของคุณ',Smartphone)}
        {identity.factors?.passkey&&choice('passkey','Passkey','ใบหน้า ลายนิ้วมือ หรือ PIN อุปกรณ์',Fingerprint)}
      </div></section>}
      {(!hasTotp||identity.factors?.line)&&<section aria-labelledby="mfa-other"><div className="mfa-group-heading"><h2 id="mfa-other">{recommended?'วิธีอื่นที่ใช้ได้':'วิธียืนยันของคุณ'}</h2><span>{isAdmin?'เข้าสู่บัญชีก่อน ยืนยันสิทธิ์ Admin ภายหลัง':'เลือกช่องทางที่คุณเข้าถึงได้'}</span></div><div className="mfa-method-grid">
        {!hasTotp&&choice('email','Email OTP','ส่งรหัสพร้อม Ref ไปยังอีเมลของคุณ',Mail)}
        {identity.factors?.line&&choice('line','LINE','เลือกเลขใน LINE ให้ตรงกับหน้าจอ',MessageCircle)}
      </div></section>}
    </div>
    <section id="mfa-challenge" className="mfa-challenge" aria-labelledby="mfa-challenge-title">
      <h2 id="mfa-challenge-title" ref={challengeHeading} tabIndex={-1}>{labels[method]}</h2>
      <p className="mfa-challenge-description">{method==='totp'?'กรอกรหัส 6 หลักจากแอป Authenticator':method==='email'?'รับรหัสยืนยัน 6 หลักผ่านอีเมลของคุณ':method==='passkey'?'ใช้ Passkey ที่ผูกไว้กับบัญชีนี้เพื่อยืนยัน':method==='line'?'ส่งคำขอไปยัง LINE ที่ผูกไว้ แล้วเลือกเลขให้ตรงกัน':'กรอก Recovery code ที่ยังไม่เคยใช้'}</p>
      {error&&<div className="inline-error" role="alert">{error}</div>}
      {method==='email'&&<><button className="button secondary full-width" disabled={working||remaining>0} onClick={()=>void send()}><Mail size={16}/>{remaining>0?`ส่งใหม่ได้ใน ${remaining} วินาที`:sent?'ส่งรหัสอีกครั้ง':'ส่งรหัสไปยังอีเมล'}</button>{sent&&<p className="auth-success" role="status">ส่งรหัสแล้ว กรุณาตรวจสอบกล่องจดหมายและสแปม</p>}{otp?.reference&&<p className="otp-reference">Ref: <strong>{otp.reference}</strong><br/>ใช้รหัสจากอีเมลที่มี Ref ตรงกัน</p>}</>}
      {['totp','email','recovery'].includes(method)&&<form onSubmit={verify}>{method==='recovery'?<label className="field">Recovery code<input autoComplete="one-time-code" maxLength={64} placeholder="Recovery code" value={code} onChange={e=>setCode(e.target.value)} required disabled={working}/></label>:<OtpInput key={method} value={code} onChange={setCode} disabled={working}/>}<button className="button primary full-width" disabled={working||(method==='recovery'?!code.trim():code.length!==6)||(method==='email'&&!otp?.reference)}>{working?'กำลังตรวจสอบ…':'ยืนยันและเข้าสู่ระบบ'}<ArrowRight size={16}/></button></form>}
      <ExtraMfa identity={identity} onVerified={onVerified} method={method==='line'||method==='passkey'?method:null} onBusyChange={setAlternativeBusy}/>
      {isAdmin&&<p className="mfa-access-note"><ShieldCheck size={16}/><span>{method==='line'?'เข้าใช้บัญชีด้วย LINE ได้ จากนั้นกด “ยืนยันสิทธิ์ Admin” ด้วย Passkey หรือ Authenticator เมื่อต้องการจัดการระบบ':method==='email'?'เข้าใช้บัญชีด้วยอีเมลได้ จากนั้นตั้งค่า Authenticator ก่อนเปิดสิทธิ์ผู้ดูแล':method==='recovery'?'ใช้รหัสกู้คืนเพื่อกลับไปตั้งค่า Authenticator ใหม่ก่อนเปิดสิทธิ์ผู้ดูแล':'วิธีนี้เปิดสิทธิ์ผู้ดูแลได้เลย การเปิดอ่านหน้าทั่วไปไม่ต้องยืนยันซ้ำ'}</span></p>}
    </section>
    {hasTotp&&<section className="mfa-recovery-group" aria-labelledby="mfa-recovery-title"><div className="mfa-group-heading"><h2 id="mfa-recovery-title"><LifeBuoy size={16}/>กู้คืนบัญชี</h2><span>เมื่อใช้วิธีที่ผูกไว้ไม่ได้</span></div><div className="mfa-method-grid">
      {choice('recovery','Recovery code','ใช้รหัสสำรองที่บันทึกไว้ได้ครั้งเดียว',KeyRound)}
      <button className="mfa-method-choice" type="button" aria-label="ขอรีเซ็ต MFA" disabled={working} onClick={()=>setReset(true)}><span className="mfa-choice-top"><LifeBuoy size={21}/><ArrowRight size={15}/></span><strong>ขอรีเซ็ต MFA</strong><small>เครื่องหายหรือไม่มีรหัส ให้ผู้ดูแลตรวจหลักฐาน</small></button>
    </div></section>}
    <button className="auth-text-button" onClick={()=>void onLogout()} disabled={working}>ใช้บัญชีอื่น</button><p className="auth-note"><LockKeyhole size={13}/>ห้ามแชร์รหัสยืนยันให้ผู้อื่น</p>
  </AuthLayout>;
}
