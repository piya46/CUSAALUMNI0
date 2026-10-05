import { useEffect,useState } from 'react';
import { CheckCircle2,ShieldCheck,ArrowRight } from 'lucide-react';
import { AuthLayout } from '../components/AuthLayout';
import { api,setCsrfToken } from '../models/api';
import type { Identity } from '../models/types';
import './auth.css';
import './consent.css';
type Context={application:{name:string};returnTo:string;missing:string[];enrolled:boolean;blocked:boolean;ready:boolean;
  registration:string;pendingDays:number;inactiveDays:number|null;noticeDays:number;totpEnabled:boolean};
const labels:Record<string,string>={phone:'ยืนยันเบอร์มือถือ',line:'ผูกบัญชี LINE',strong_mfa:'ยืนยันด้วย Passkey หรือ Authenticator'};
export default function ServiceEnrollment(){
  const [value,setValue]=useState<Context>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [returnTo]=useState(()=>new URLSearchParams(location.search).get('returnTo')??'');
  useEffect(()=>{let alive=true;void(async()=>{try{
    const identity=await api<Identity>('/auth/me');setCsrfToken(identity.csrfToken);
    if(identity.requiresMfa||identity.phoneRequired){location.replace(`/login?${new URLSearchParams({returnTo})}`);return;}
    const context=await api<Context>(`/sso/enrollment?${new URLSearchParams({returnTo})}`);if(alive)setValue(context);
  }catch(e){if(alive)setError((e as Error).message);}})();return()=>{alive=false;};},[returnTo]);
  async function enroll(){if(busy)return;setBusy(true);setError('');try{setValue(await api('/sso/enrollment','POST',{returnTo}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <AuthLayout wide><div className="auth-hero-icon"><ShieldCheck size={28}/></div><p className="auth-step">เตรียมบัญชีสำหรับ Service</p>
    <h1>{value?.application.name??'ตรวจสอบเงื่อนไขการเข้าใช้งาน'}</h1>
    {!value&&!error&&<p role="status">กำลังตรวจสอบบัญชีและข้อกำหนด…</p>}
    {value&&<><p className="auth-description">สมาชิกและสิทธิ์ของระบบนี้แยกจาก CUSA ภายใน การสมัครไม่ให้สิทธิ์เข้าถึงระบบอื่น</p>
      {value.blocked?<div className="form-error">สมาชิกถูกระงับหรือคำขอสมัครหมดอายุ กรุณาติดต่อผู้ดูแล Service เพื่อพิจารณาสิทธิ์</div>:<>
        {!value.enrolled&&<div className="consent-purpose"><h2>เข้าร่วม Service</h2><p>{value.registration==='closed'?'ระบบนี้รับเฉพาะสมาชิกที่ผู้ดูแลเพิ่มให้ กรุณาติดต่อผู้ดูแล':value.registration==='invite'?'บัญชี Google นี้ต้องมีคำเชิญที่ยังไม่หมดอายุ':'ระบบนี้เปิดรับสมาชิกใหม่ผ่าน Google และการยืนยันตัวตน'}</p>
          {value.registration!=='closed'&&<button className="button primary" disabled={busy} onClick={()=>void enroll()}>{busy?'กำลังตรวจสอบ…':'เริ่มสมัครสมาชิกระบบนี้'}</button>}</div>}
        {value.missing.length>0&&<div className="consent-purpose"><h2>สิ่งที่ต้องทำก่อนเข้าใช้งาน</h2><ul>{value.missing.map(m=><li key={m}>{labels[m]}</li>)}</ul>
          {value.missing.includes('line')&&!value.totpEnabled&&<p>ก่อนผูก LINE ให้ตั้งค่า Authenticator และเก็บ Recovery codes เพื่อป้องกันการยึดบัญชี</p>}
          <a className="button secondary" href={`/login?${new URLSearchParams({returnTo:value.returnTo,manage:'security'})}`}>ตั้งค่าการยืนยันตัวตน<ArrowRight size={16}/></a></div>}
        {value.ready&&<><p className="factor-success"><CheckCircle2 size={18}/>ครบเงื่อนไขแล้ว ขั้นถัดไปคือเลือกอนุญาตข้อมูล</p><a className="button primary full-width" href={value.returnTo}>ตรวจสอบและอนุญาตข้อมูล<ArrowRight size={18}/></a></>}
      </>}
      <p className="consent-note">คำขอสมัครที่ยังไม่สำเร็จมีอายุ {value.pendingDays} วัน หลังหมดอายุต้องติดต่อผู้ดูแล ขณะนี้นโยบายบัญชีไม่ใช้งานอยู่ในโหมดตรวจสอบ ยังไม่มีการลบอัตโนมัติ</p>
      <a className="auth-text-button" href="/login">ยกเลิกและกลับไปจัดการความปลอดภัยบัญชี</a></>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </AuthLayout>;
}
