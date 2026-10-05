import { useEffect, useState } from 'react';
import { ArrowRight, Check, Globe2, ShieldCheck } from 'lucide-react';
import { api, setCsrfToken } from '../models/api';
import type { Identity } from '../models/types';
import { AuthLayout } from '../components/AuthLayout';
import './auth.css';
import './consent.css';

type Context = {application:{name:string;origin:string};purpose:string;noticeVersion:string;policyVersion:number;
  scopes:{scope:string;required:boolean;title:string;detail:string}[]};
export default function Consent() {
  const [context,setContext]=useState<Context>(),[email,setEmail]=useState(''),[selected,setSelected]=useState<string[]>(['identity:read']);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  const [request]=useState(()=>new URLSearchParams(location.search).get('request')??'');
  useEffect(()=>{let active=true;void (async()=>{
    try {
      if(!/^[A-Za-z0-9_-]{43}$/.test(request))throw new Error('คำขอไม่ถูกต้อง กรุณาเริ่มเข้าสู่ระบบจาก Service อีกครั้ง');
      const identity=await api<Identity>('/auth/me');
      if(identity.requiresMfa||identity.phoneRequired)throw new Error('กรุณาเข้าสู่ระบบและยืนยันตัวตนให้ครบ แล้วเริ่มใหม่จาก Service');
      const result=await api<Context>(`/sso/consent?${new URLSearchParams({request})}`);
      if(active){setCsrfToken(identity.csrfToken);setEmail(identity.user.email);setContext(result);setSelected(result.scopes.filter(scope=>scope.required).map(scope=>scope.scope));}
    }catch(e){if(active)setError((e as Error).message);}finally{if(active)setLoading(false);}
  })();return()=>{active=false;};},[request]);
  async function decide(approved:boolean){
    if(busy||!context)return;setBusy(true);setError('');
    try{
      const {redirectTo}=await api<{redirectTo:string}>('/sso/consent','POST',{request,approved,scopes:approved?selected:[]});
      const destination=new URL(redirectTo);
      if(destination.origin!==context.application.origin)throw new Error('ปลายทางไม่ตรงกับ Service กรุณาเริ่มใหม่');
      location.replace(destination.toString());
    }catch(e){setError((e as Error).message);setBusy(false);}
  }
  return <AuthLayout wide><div className="auth-hero-icon"><ShieldCheck size={28}/></div><p className="auth-step">คุณเป็นผู้เลือกข้อมูลที่แชร์</p>
    <h1>อนุญาตให้เชื่อมต่อบัญชี</h1>
    {loading?<p role="status">กำลังตรวจสอบ Service และสิทธิ์ของคุณ…</p>:context?<>
      <div className="consent-recipient"><Globe2 size={26}/><div><span>ส่งข้อมูลให้</span><h2>{context.application.name}</h2><small>{context.application.origin}</small></div></div>
      <p className="auth-description">ใช้บัญชี <strong>{email}</strong></p>
      <div className="consent-purpose"><strong>วัตถุประสงค์ที่ Service แจ้ง</strong><p>{context.purpose}</p></div>
      <p className="consent-intro">ตรวจรายการจำเป็นของ Service และเลือกข้อมูลเสริมที่ต้องการแชร์ ข้อมูลเสริมไม่ถูกเลือกไว้ล่วงหน้า หากไม่ต้องการส่งข้อมูลจำเป็นสามารถกดไม่อนุญาตได้</p>
      <fieldset className="consent-scopes" disabled={busy}><legend>ข้อมูลที่จะอนุญาต</legend>{context.scopes.map(item=>
        <label key={item.scope} className={`consent-scope ${selected.includes(item.scope)?'selected':''}`}>
          <input type="checkbox" checked={selected.includes(item.scope)} disabled={item.required||busy}
            onChange={e=>setSelected(values=>e.target.checked?[...values,item.scope]:values.filter(value=>value!==item.scope))}/>
          <span><strong>{item.title}{item.required&&<small className="consent-required">จำเป็นสำหรับการเข้าสู่ระบบ</small>}</strong><small>{item.detail}</small></span>
          {selected.includes(item.scope)&&<Check className="consent-check" size={18} aria-hidden="true"/>}
        </label>)}</fieldset>
      <p className="consent-note">การกดอนุญาตจะส่งเฉพาะรายการข้างต้น คุณถอนการอนุญาตได้ที่หน้า “ความปลอดภัย” ของ CUSA SSO การถอนจะหยุดการเข้าถึงผ่าน Token นี้ แต่ไม่ลบข้อมูลที่ Service ได้รับไปแล้ว</p>
      <div className="consent-actions"><button className="button secondary" disabled={busy} onClick={()=>void decide(false)}>ไม่อนุญาต</button>
        <button className="button primary" disabled={busy} onClick={()=>void decide(true)}>{busy?'กำลังดำเนินการ…':'อนุญาตและเข้าสู่ระบบ'}<ArrowRight size={18}/></button></div>
      <p className="consent-version">ข้อความการอนุญาต v{context.noticeVersion} · นโยบาย Service v{context.policyVersion}</p>
    </>:<a className="button secondary full-width" href="/login">กลับไป CUSA SSO</a>}
    {error&&<div className="form-error" role="alert">{error}</div>}
  </AuthLayout>;
}
