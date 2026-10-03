import { useEffect, useId, useRef, useState } from 'react';
import { Check, Fingerprint, MessageCircle, Smartphone, Send, Timer } from 'lucide-react';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type { ConfirmationResult, RecaptchaVerifier } from 'firebase/auth';
import { api, ApiError } from '../models/api';
import { firebasePhoneError } from '../models/firebasePhoneError';
import { displayThaiMobile, thaiMobile } from '../models/phone';
import type { LoginContext } from '../models/login';
import { AuthLayout } from '../components/AuthLayout';
import { OtpInput } from '../components/OtpInput';
import { Panel } from '../components/ui';
import type { Identity } from '../models/types';
import './additional-factors.css';
interface Settings {passkeyEnabled:boolean;lineEnabled:boolean;phoneEnabled:boolean;line:boolean;phoneVerified:boolean;passkeys:{id:string;name:string}[];firebase?:{apiKey:string;authDomain:string;projectId:string;appId:string}}

export function AdditionalFactors({identity,onIdentityChanged}:{identity:Identity;onIdentityChanged?:()=>Promise<void>}){
  const [settings,setSettings]=useState<Settings|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[name,setName]=useState('Passkey ของฉัน'),[notice,setNotice]=useState('');
  const refresh=()=>api<Settings>('/auth/factors').then(setSettings);
  useEffect(()=>{void refresh().catch(e=>setError(e.message));const state=new URLSearchParams(location.search).get('line');if(state){setNotice(state==='linked'?'ผูก LINE แล้ว กรุณาเพิ่มเพื่อน Official Account เพื่อรับข้อความ':'ผูก LINE ไม่สำเร็จ กรุณาเริ่มใหม่');const url=new URL(location.href);url.searchParams.delete('line');history.replaceState(null,'',url.pathname+url.search+url.hash);}},[]);
  async function work(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();await refresh();await onIdentityChanged?.();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const canManage=identity.user.totpEnabled&&identity.mfaMethod!=='recovery';
  useEffect(()=>{
    if(!settings?.phoneEnabled)return;
    const focusPhone=()=>{if(location.hash==='#phone-verification')document.getElementById('phone-verification')?.focus();};
    focusPhone();window.addEventListener('hashchange',focusPhone);
    return()=>window.removeEventListener('hashchange',focusPhone);
  },[settings?.phoneEnabled]);
  async function register(){
    const {startRegistration}=await import('@simplewebauthn/browser');
    const result=await api<{challengeId:string;options:PublicKeyCredentialCreationOptionsJSON}>('/auth/passkeys/register/options','POST',{});
    const response=await startRegistration({optionsJSON:result.options});
    await api('/auth/passkeys/register/verify','POST',{challengeId:result.challengeId,response,name});setNotice('เพิ่ม Passkey แล้ว ใช้ได้ในขั้นตอน MFA หลังเข้าสู่ระบบด้วย Google');
  }
  return <Panel title="วิธียืนยันเพิ่มเติม" subtitle="Google, Authenticator และ Recovery codes เดิมยังใช้งานได้"><div className="additional-factors">
    {error&&<p role="alert" className="inline-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!canManage&&<p className="field-hint">เปิด Authenticator และเก็บ Recovery codes ก่อนเพิ่ม Passkeys หรือ LINE</p>}
    {settings?.passkeyEnabled&&<section><h3><Fingerprint size={22}/>Passkeys</h3><p>ใช้การปลดล็อกอุปกรณ์ เช่น ใบหน้า ลายนิ้วมือ หรือ PIN ระบบเก็บเฉพาะกุญแจสาธารณะ ไม่รับข้อมูลชีวมิติ</p>
      <form onSubmit={e=>{e.preventDefault();void work(register);}}><label className="field">ชื่ออุปกรณ์<input value={name} onChange={e=>setName(e.target.value)} maxLength={80} required disabled={!canManage||busy}/></label><button className="button secondary" disabled={!canManage||busy}>เพิ่ม Passkey</button></form>
      {settings.passkeys.map(key=><div className="factor-item" key={key.id}><span>{key.name}</span><button className="text-link" disabled={!canManage||busy} onClick={()=>{if(window.confirm(`ลบ Passkey ${key.name} และออกจากระบบอุปกรณ์อื่น?`))void work(async()=>{await api(`/auth/passkeys/${key.id}`,'DELETE');});}}>ลบ Passkey</button></div>)}</section>}
    <section><h3><MessageCircle size={22}/>LINE Number Matching</h3><p>เลือกเลขใน LINE ให้ตรงกับหน้าจอ CUSA SSO เฉพาะเมื่อคุณเริ่มเข้าสู่ระบบด้วยตัวเอง</p>{settings?.lineEnabled?<button className="button secondary" disabled={!canManage||busy} onClick={()=>void work(async()=>{
      if(settings.line){if(!window.confirm('ถอด LINE และออกจากระบบอุปกรณ์อื่น?'))return;await api('/auth/line/link','DELETE');setNotice('ถอดการผูก LINE แล้ว');}
      else{const {url}=await api<{url:string}>('/auth/line/link','POST',{});window.location.assign(url);}
    })}>{settings.line?'ถอดการผูก LINE':'ผูกบัญชี LINE'}</button>:<p className="field-hint">ผู้ดูแลยังไม่เปิดใช้งาน LINE</p>}</section>
    {settings?.phoneEnabled&&<section><h3 id="phone-verification" tabIndex={-1}><Smartphone size={22}/>ยืนยันเบอร์มือถือ</h3>{settings.phoneVerified?<p className="factor-success"><Check size={18}/>ยืนยันเบอร์แล้ว · ใช้สำหรับยืนยันเบอร์ครั้งแรก ไม่ใช้แทน MFA</p>:<PhoneVerification settings={settings} onVerified={async()=>{await refresh();await onIdentityChanged?.();setNotice('ยืนยันเบอร์มือถือสำเร็จ บันทึกในบัญชีของคุณแล้ว');}}/>}</section>}
    {identity.user.role==='admin'&&<p className="field-hint">Admin ใช้ Passkey หรือ Authenticator ได้ รายการสำคัญใช้ผลยืนยันภายใน 5 นาที</p>}
  </div></Panel>;
}

export function ExtraMfa({identity,onVerified}:{identity:Identity;onVerified:()=>Promise<void>}){
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[line,setLine]=useState<{challengeId:string;number:string;reference?:string;expiresIn:number}|null>(null),[deadline,setDeadline]=useState(0),[now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const remaining=Math.max(0,Math.ceil((deadline-now)/1000));
  useEffect(()=>{
    if(!line)return;let alive=true,working=false;
    const timer=setInterval(async()=>{if(working||!alive)return;working=true;try{
      const state=await api<{status:string}>(`/auth/line/challenges/${line.challengeId}`);
      if(!alive)return;
      if(state.status==='approved'){clearInterval(timer);setBusy(true);await api('/auth/line/verify','POST',{challengeId:line.challengeId});await onVerified();}
      if(['denied','expired','used'].includes(state.status)){clearInterval(timer);setLine(null);setError(state.status==='denied'?'คำขอ LINE ถูกปฏิเสธ กรุณาเริ่มใหม่':'คำขอ LINE หมดอายุหรือใช้แล้ว');}
    }catch(e){if(alive){clearInterval(timer);setError((e as Error).message);setLine(null);}}finally{working=false;if(alive)setBusy(false);}},2500);
    return()=>{alive=false;clearInterval(timer);};
  },[line]);
  async function act(action:()=>Promise<void>){setBusy(true);setError('');try{await action();}catch(e){setError((e as Error).message);if(e instanceof ApiError&&e.retryAfter){const stamp=Date.now();setNow(stamp);setDeadline(stamp+e.retryAfter*1000);}}finally{setBusy(false);}}
  const lineAvailable=identity.user.role!=='admin'&&identity.factors?.line;
  if(!identity.factors?.passkey&&!lineAvailable)return null;
  return <div className="extra-mfa"><p>หรือใช้วิธียืนยันที่ผูกไว้</p>{error&&<p className="inline-error" role="alert">{error}</p>}
    {identity.factors?.passkey&&<button className="button secondary full-width" disabled={busy} onClick={()=>void act(async()=>{
      const {startAuthentication}=await import('@simplewebauthn/browser');
      const result=await api<{challengeId:string;options:PublicKeyCredentialRequestOptionsJSON}>('/auth/passkeys/authenticate/options','POST',{});
      const response=await startAuthentication({optionsJSON:result.options});await api('/auth/passkeys/authenticate/verify','POST',{challengeId:result.challengeId,response});await onVerified();
    })}><Fingerprint size={18}/>ยืนยันด้วย Passkey</button>}
    {lineAvailable&&<button className="button secondary full-width" disabled={busy||remaining>0} onClick={()=>void act(async()=>{const result=await api<{challengeId:string;number:string;reference?:string;expiresIn:number;retryAfter:number}>('/auth/line/send','POST',{});setLine(result);const stamp=Date.now();setNow(stamp);setDeadline(stamp+result.retryAfter*1000);})}><MessageCircle size={18}/>{remaining?`ขอ LINE ใหม่ได้ใน ${remaining} วินาที`:'ยืนยันผ่าน LINE'}</button>}
    {line&&<div className="number-matching" role="status"><p>เปิด LINE แล้วเลือกเลขนี้</p><strong>{line.number}</strong>{line.reference&&<p className="line-reference">Ref: {line.reference}</p>}<small>ใช้สำหรับเข้าสู่ระบบ CUSA SSO · หมดอายุใน 3 นาที<br/>ห้ามบอกเลขให้ผู้อื่นหรืออนุมัติคำขอที่คุณไม่ได้เริ่ม</small></div>}
  </div>;
}

export function PhoneVerification({settings,onVerified,serviceName}:{settings:Settings;onVerified:()=>Promise<unknown>;serviceName?:string}){
  const [phone,setPhone]=useState(''),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[deadline,setDeadline]=useState(0),[now,setNow]=useState(Date.now()),[sent,setSent]=useState(false),[consent,setConsent]=useState(false);
  const challenge=useRef(''),confirmation=useRef<ConfirmationResult|null>(null),captcha=useRef<RecaptchaVerifier|null>(null),cleanupAuth=useRef<(()=>Promise<void>)|null>(null);
  const captchaId=`phone-captcha-${useId().replace(/[^a-zA-Z0-9]/g,'')}`;
  const phoneId=`${captchaId}-input`,hintId=`${captchaId}-hint`;
  const normalizedPhone=thaiMobile(phone);
  const [touched,setTouched]=useState(false);
  const sending=useRef(false);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>{clearInterval(timer);captcha.current?.clear();void cleanupAuth.current?.();confirmation.current=null;};},[]);
  const remaining=Math.max(0,Math.ceil((deadline-now)/1000));
  async function send(){if(sending.current||busy||!normalizedPhone||!consent||remaining>0)return;sending.current=true;setBusy(true);setError('');try{
    const [{initializeApp,getApps},{initializeAuth,getAuth,inMemoryPersistence,RecaptchaVerifier,signInWithPhoneNumber,signOut}]=await Promise.all([import('firebase/app'),import('firebase/auth')]);
    const existing=getApps().find(a=>a.name==='cusa-phone');const app=existing??initializeApp(settings.firebase!,'cusa-phone');
    const auth=existing?getAuth(app):initializeAuth(app,{persistence:inMemoryPersistence});auth.languageCode='th';cleanupAuth.current=()=>signOut(auth);
    await signOut(auth);
    const result=await api<{challengeId:string;retryAfter:number}>('/auth/phone/start','POST',{phone:normalizedPhone,acknowledged:true,noticeVersion:'1.2'});challenge.current=result.challengeId;const stamp=Date.now();setNow(stamp);setDeadline(stamp+result.retryAfter*1000);confirmation.current=null;setSent(false);
    captcha.current?.clear();captcha.current=new RecaptchaVerifier(auth,captchaId,{size:window.matchMedia('(max-width:480px)').matches?'compact':'normal'});
    confirmation.current=await signInWithPhoneNumber(auth,normalizedPhone,captcha.current);setSent(true);setCode('');
  }catch(e){setError(e instanceof ApiError?e.message:firebasePhoneError(e,'send'));if(e instanceof ApiError&&e.retryAfter){const stamp=Date.now();setNow(stamp);setDeadline(stamp+e.retryAfter*1000);}captcha.current?.clear();captcha.current=null;}finally{setBusy(false);sending.current=false;}}
  async function verify(){setBusy(true);setError('');try{if(!confirmation.current)throw new Error();const result=await confirmation.current.confirm(code);const idToken=await result.user.getIdToken();await api('/auth/phone/verify','POST',{challengeId:challenge.current,idToken});await cleanupAuth.current?.();confirmation.current=null;await onVerified();}catch(e){setError(e instanceof ApiError?e.message:firebasePhoneError(e,'verify'));}finally{setBusy(false);}}
  return <div className="phone-verification">
    <ol className="phone-steps" aria-label="ขั้นตอนยืนยันเบอร์"><li className={!sent?'current':'complete'} aria-current={!sent?'step':undefined}><span>{sent?<Check size={13}/>:1}</span>กรอกเบอร์</li><li className={sent?'current':''} aria-current={sent?'step':undefined}><span>2</span>ยืนยันรหัส SMS</li></ol>
    <div className="phone-purpose"><Smartphone size={20}/><div><strong>ยืนยันเบอร์มือถือสำหรับบัญชี CUSA SSO</strong>{serviceName&&<span>เพื่อเริ่มใช้งาน {serviceName}</span>}<small>ยืนยันว่าเป็นเบอร์ของคุณ ไม่ใช่การตรวจบัตรประชาชน และไม่ใช้ SMS แทน MFA</small></div></div>
    <div className="field"><label htmlFor={phoneId}>เบอร์มือถือของคุณ</label><div className="phone-input-group"><span className="phone-country" aria-hidden="true">🇹🇭 <span>ไทย <small>+66</small></span></span><input id={phoneId} type="tel" inputMode="tel" value={phone} placeholder="081 234 5678" maxLength={24} onChange={e=>{setPhone(e.target.value);setSent(false);setCode('');setError('');confirmation.current=null;}} onBlur={()=>{setTouched(true);setPhone(displayThaiMobile(phone));}} disabled={busy} autoComplete="tel-national" aria-describedby={hintId} aria-invalid={touched&&!!phone&&!normalizedPhone}/>{normalizedPhone&&<Check size={19} className="phone-valid" aria-label="รูปแบบเบอร์ถูกต้อง"/>}</div><small id={hintId} className={touched&&!!phone&&!normalizedPhone?'phone-invalid':'field-hint'}>{touched&&!!phone&&!normalizedPhone?'กรอกเบอร์มือถือไทย 10 หลัก เริ่มด้วย 06, 08 หรือ 09':'กรอกเบอร์ไทย 10 หลักตามปกติ ไม่ต้องเปลี่ยน 0 เป็น +66'}</small></div>
    <label className="checkbox-row"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} disabled={busy}/><span>ฉันได้อ่าน<a href="/privacy" target="_blank" rel="noopener noreferrer">นโยบายความเป็นส่วนตัว</a> และยินยอมให้ส่งเบอร์ไปยัง Google/Firebase เพื่อรับ SMS และป้องกันการใช้งานผิดวัตถุประสงค์</span></label>
    {error&&<p className="inline-error" role="alert">{error}</p>}<div id={captchaId}/>
    <button className={`button ${sent?'secondary':'primary'}`} disabled={busy||remaining>0||!consent||!normalizedPhone} onClick={()=>void send()}>{remaining?<Timer size={17}/>:<Send size={17}/>} {busy?'กำลังดำเนินการ…':remaining?`ส่งใหม่ได้ใน ${remaining} วินาที`:'ส่ง SMS ยืนยันเบอร์'}</button>
    {sent&&<form className="sms-confirmation" onSubmit={e=>{e.preventDefault();void verify();}}><p className="sms-delivered" role="status"><Check size={18}/>ส่ง SMS แล้วที่ {displayThaiMobile(phone)}<br/>กรุณากรอกภายใน 3 นาที</p><OtpInput label="รหัส SMS 6 หลัก" value={code} onChange={setCode} disabled={busy} autoFocus/><button className="button primary" disabled={busy||code.length!==6}>{busy?'กำลังตรวจสอบ…':'ยืนยันเบอร์มือถือ'}</button><small>รหัสนี้ใช้ยืนยันเบอร์ใน CUSA SSO เท่านั้น ห้ามบอกรหัสให้ผู้อื่น</small></form>}
  </div>;
}
export function PhoneGate({onVerified,onLogout,context}:{onVerified:()=>Promise<void>;onLogout:()=>Promise<void>;context?:LoginContext|null}){
  const [settings,setSettings]=useState<Settings|null>(null),[error,setError]=useState('');
  useEffect(()=>{void api<Settings>('/auth/factors').then(setSettings).catch(e=>setError(e.message));},[]);
  return <AuthLayout><div className="auth-hero-icon"><Smartphone size={28}/></div><h1>ยืนยันเบอร์มือถือครั้งแรก</h1><p className="auth-description">อีกขั้นตอนเดียวก่อนเริ่มใช้งาน</p>{error&&<p className="inline-error" role="alert">{error}</p>}{settings?.phoneEnabled?<PhoneVerification settings={settings} onVerified={onVerified} serviceName={context?.application.name}/>:<p role="status">กำลังตรวจสอบบริการ SMS หากไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแล</p>}<button className="auth-text-button" onClick={()=>void onLogout()}>ออกจากระบบ</button></AuthLayout>;
}
