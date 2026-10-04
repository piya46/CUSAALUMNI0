import { useEffect, useState } from 'react';
import { api } from '../models/api';
import './consent.css';
const scopes=[['identity:read','รหัสบัญชีและ Role ของ Service'],['profile','ชื่อ นามสกุล รูปภาพ หน่วยงาน'],['email','อีเมล'],['phone','เบอร์โทรและเวลายืนยัน'],['phone:match','ตรวจว่าเบอร์ตรงกัน (ไม่ส่งเบอร์จริง)'],['line','LINE UID ที่ผูกไว้'],['assurance','วิธี เวลา และระดับการยืนยัน']] as const;
export function SharingSettings({applicationId}:{applicationId:string}){
  const [value,setValue]=useState<{scopes:string[];purpose:string;version:number}>(),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function load(){if(open){setOpen(false);return;}setBusy(true);setMessage('');try{setValue(await api(`/admin/applications/${applicationId}/sharing`));setOpen(true);}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
  async function save(){if(!value||busy)return;setBusy(true);setMessage('');try{await api(`/admin/applications/${applicationId}/sharing`,'PUT',{scopes:value.scopes,purpose:value.purpose});setValue({...value,version:value.version+1});setMessage('บันทึกแล้ว สิทธิ์เดิมถูกยกเลิก ผู้ใช้ต้องอนุญาตใหม่เมื่อเข้า Service อีกครั้ง');}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
  return <div className="sharing-policy"><button className="button secondary" disabled={busy} onClick={()=>void load()}>{open?'ปิดการตั้งค่าข้อมูล':'ตั้งค่าข้อมูลและ Consent'}</button>
    {open&&value&&<form onSubmit={e=>{e.preventDefault();void save();}}><p>กำหนดข้อมูลสูงสุดที่ Service ขอได้ ผู้ใช้เลือกอนุญาตอีกครั้งก่อนส่งข้อมูลจริง</p>
      <label className="field">วัตถุประสงค์การใช้ข้อมูล<textarea required minLength={10} maxLength={500} value={value.purpose} onChange={e=>setValue({...value,purpose:e.target.value})} disabled={busy}/></label>
      {scopes.map(([scope,label])=><label className="sharing-scope" key={scope}><input type="checkbox" disabled={busy||scope==='identity:read'} checked={value.scopes.includes(scope)} onChange={e=>setValue({...value,scopes:e.target.checked?[...value.scopes,scope]:value.scopes.filter(s=>s!==scope)})}/>{label}</label>)}
      <small>การบันทึกจะเปลี่ยนรุ่นนโยบายและยกเลิกสิทธิ์เดิมของ Service นี้ การตรวจ Token ที่แคชไว้อาจเห็นการเปลี่ยนแปลงช้าสูงสุด 5 วินาที</small>
      <button className="button primary" disabled={busy}>บันทึกนโยบายข้อมูล</button></form>}{message&&<p role="status">{message}</p>}
  </div>;
}
export function ConsentHistory(){
  const [items,setItems]=useState<{id:string;name:string;scope:string;approvedAt:string}[]>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState<string>();
  async function load(){try{const result=await api<{consents:NonNullable<typeof items>}>('/sso/consents');setItems(result.consents);}catch(e){setError((e as Error).message);}}
  useEffect(()=>{void load();},[]);
  async function revoke(id:string){setBusy(true);setError('');try{await api(`/sso/consents/${id}`,'DELETE');setItems(old=>old?.filter(item=>item.id!==id));setConfirm(undefined);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <section className="consent-history" aria-labelledby="consent-history-title"><h2 id="consent-history-title">ข้อมูลที่อนุญาตให้ Service ใช้</h2>
    <p>การอนุญาตล่าสุดที่ยังไม่ถอน สูงสุด 100 รายการ การถอนหยุดการใช้ SSO token ที่ผูกกับรายการนี้ แต่ไม่ลบข้อมูลหรือเซสชันที่ระบบลูกเก็บเอง</p>
    {!items&&!error&&<p role="status">กำลังโหลด…</p>}{items?.length===0&&<p>ยังไม่มีการอนุญาตที่ใช้งานอยู่</p>}
    <ul>{items?.map(item=><li key={item.id}><strong>{item.name}</strong><small>{item.scope.split(' ').map(s=>scopes.find(([code])=>code===s)?.[1]??s).join(' · ')}</small><small>{new Date(item.approvedAt).toLocaleString('th-TH')}</small>
      {confirm===item.id?<><p>ถอนการอนุญาตครั้งนี้ให้ {item.name} ใช่ไหม?</p><button className="button secondary danger-text" disabled={busy} onClick={()=>void revoke(item.id)}>ยืนยันถอนการอนุญาต</button><button className="auth-text-button" disabled={busy} onClick={()=>setConfirm(undefined)}>ยกเลิก</button></>:<button className="button secondary" disabled={busy} onClick={()=>setConfirm(item.id)}>ถอนการอนุญาต</button>}</li>)}</ul>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
