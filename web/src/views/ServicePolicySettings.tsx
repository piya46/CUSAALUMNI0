import {useState} from 'react';
import {api} from '../models/api';
import type {ServiceRole} from '../models/types';
type Policy={registration:'closed'|'invite'|'open';defaultRoleId:string|null;requirePhone:boolean;requireLine:boolean;
 minimumMfa:'standard'|'strong';requiredScopes:string[];registrationLimit:number;pendingDays:number;inactiveDays:number|null;
 noticeDays:number;recoveryDays:number;version:number;lifecycleMode:'preview'};
type Preview={data:{userId:string;email:string;reason:string;lastActivityAt:string|null;lastReportedActivityAt:string|null}[];
 meta:{hasMore:boolean;nextCursor:string|null};warning:string};
const scopes=[['identity:read','รหัสบัญชีและ Role'],['profile','ชื่อและโปรไฟล์'],['email','อีเมล'],['phone','เบอร์โทร'],['phone:match','ตรวจเบอร์ตรงกัน'],['line','LINE UID'],['assurance','ระดับการยืนยัน']] as const;
export function ServicePolicySettings({applicationId}:{applicationId:string}){
 const [value,setValue]=useState<Policy>(),[roles,setRoles]=useState<ServiceRole[]>([]),[open,setOpen]=useState(false),[busy,setBusy]=useState(false);
 const [message,setMessage]=useState(''),[error,setError]=useState(''),[preview,setPreview]=useState<Preview>(),[email,setEmail]=useState('');
 const [invites,setInvites]=useState<{email:string;expiresAt:string}[]>([]),[invitePage,setInvitePage]=useState(1),[inviteMore,setInviteMore]=useState(false);
 const base=`/admin/applications/${applicationId}`;
 async function work(fn:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function invitations(page=1){const r=await api<{invitations:typeof invites;hasMore:boolean}>(`${base}/invitations?page=${page}`);setInvites(r.invitations);setInvitePage(page);setInviteMore(r.hasMore);}
 async function load(){if(open){setOpen(false);return;}await work(async()=>{const [p,r]=await Promise.all([api<Policy>(`${base}/access-policy`),api<{roles:ServiceRole[]}>(`${base}/roles`)]);setValue(p);setRoles(r.roles);await invitations();setOpen(true);});}
 async function save(){if(!value)return;await work(async()=>{const {version,lifecycleMode:_mode,...input}=value;setValue(await api(`${base}/access-policy`,'PUT',{...input,expectedVersion:version}));setPreview(undefined);setMessage('บันทึกนโยบายแล้ว Token เดิมต้องขออนุญาตใหม่ การลบยังอยู่ในโหมดตรวจสอบ');});}
 return <div className="sharing-policy"><button className="button secondary" disabled={busy} onClick={()=>void load()}>{open?'ปิดนโยบายสมาชิก':'นโยบายสมาชิกและการรับสมัคร'}</button>
 {open&&value&&<><form onSubmit={e=>{e.preventDefault();void save();}}><h3>สมาชิกเฉพาะ Service</h3><p>การรับสมัครไม่เพิ่มผู้ใช้ใน Allowlist ภายใน CUSA และไม่ให้สิทธิ์ระบบอื่น</p>
 <label className="field">รูปแบบรับสมาชิก<select value={value.registration} disabled={busy} onChange={e=>setValue({...value,registration:e.target.value as Policy['registration']})}><option value="closed">ปิดรับ — Admin เพิ่มสมาชิก</option><option value="invite">รับเฉพาะอีเมลที่มีคำเชิญ</option><option value="open">เปิดสมัครผ่าน Google</option></select></label>
 <label className="field">Role เริ่มต้น<select required={value.registration!=='closed'} value={value.defaultRoleId??''} disabled={busy} onChange={e=>setValue({...value,defaultRoleId:e.target.value||null})}><option value="">เลือก Role ของ Service</option>{roles.filter(r=>! /^(admin|administrator|owner|superadmin|root)$/i.test(r.code)).map(r=><option key={r.id} value={r.id}>{r.name} ({r.code})</option>)}</select></label>
 <p className="field-hint">ตรวจว่าระบบลูกตีความ Role นี้เป็นสิทธิ์พื้นฐานเท่านั้น หากยังไม่มี Role ให้สร้างที่หน้าสมาชิกแต่ละ Service</p>
 <label className="sharing-scope"><input type="checkbox" checked={value.requirePhone} disabled={busy} onChange={e=>setValue({...value,requirePhone:e.target.checked})}/>ต้องยืนยันเบอร์มือถือ</label>
 <label className="sharing-scope"><input type="checkbox" checked={value.requireLine} disabled={busy} onChange={e=>setValue({...value,requireLine:e.target.checked})}/>ต้องผูก LINE</label>
 <label className="field">ระดับยืนยันตัวตน<select disabled={busy} value={value.minimumMfa} onChange={e=>setValue({...value,minimumMfa:e.target.value as Policy['minimumMfa']})}><option value="standard">ตามนโยบาย MFA ของบัญชีเดิม</option><option value="strong">ต้องยืนยันด้วย Passkey หรือ Authenticator</option></select></label>
 <fieldset className="scope-fieldset"><legend>ข้อมูลจำเป็นก่อนเข้า Service</legend>{scopes.map(([scope,label])=><label className="sharing-scope" key={scope}><input type="checkbox" checked={value.requiredScopes.includes(scope)} disabled={busy||scope==='identity:read'} onChange={e=>setValue({...value,requiredScopes:e.target.checked?[...value.requiredScopes,scope]:value.requiredScopes.filter(s=>s!==scope)})}/>{label}</label>)}</fieldset>
 <p className="field-hint">ข้อมูลจำเป็นต้องอยู่ในรายการอนุญาตของ “ตั้งค่าข้อมูลและ Consent” และมีเหตุผลที่จำเป็นต่อการใช้ Service การบังคับผูกข้อมูลไม่ได้บังคับเปิดเผยข้อมูลนั้นอัตโนมัติ</p>
 <label className="field">เพดานสมาชิกที่สมัครเองรวมคำขอค้าง<input type="number" min={1} max={100000} required value={value.registrationLimit} onChange={e=>setValue({...value,registrationLimit:Number(e.target.value)})}/></label>
 <label className="field">อายุคำขอสมัครที่ยังไม่สำเร็จ (วัน)<input type="number" min={1} max={30} required value={value.pendingDays} onChange={e=>setValue({...value,pendingDays:Number(e.target.value)})}/></label>
 <h3>ตรวจสมาชิกไม่ใช้งาน</h3><p>โหมดตรวจสอบเท่านั้น ไม่มีการลบหรือระงับอัตโนมัติ ต้องยืนยันข้อมูลกิจกรรมจากระบบลูกและนโยบายก่อนดำเนินการ</p>
 <label className="field">ไม่ใช้งานกี่วันจึงเข้ารายงาน (เว้นว่างเพื่อปิด)<input type="number" min={30} max={3650} value={value.inactiveDays??''} onChange={e=>setValue({...value,inactiveDays:e.target.value?Number(e.target.value):null})}/></label>
 <label className="field">ระยะเวลาแจ้งล่วงหน้าที่เสนอ (วัน)<input type="number" min={7} max={90} required value={value.noticeDays} onChange={e=>setValue({...value,noticeDays:Number(e.target.value)})}/></label>
 <label className="field">ช่วงกู้คืนหลังระงับที่เสนอ (วัน)<input type="number" min={7} max={90} required value={value.recoveryDays} onChange={e=>setValue({...value,recoveryDays:Number(e.target.value)})}/></label>
 <button className="button primary" disabled={busy}>บันทึกนโยบายสมาชิก</button></form>
 <section><h3>คำเชิญตามอีเมล Google</h3><p>เพิ่มรายชื่อที่มีสิทธิ์เริ่มสมัครภายใน 7 วัน ไม่มีการส่งอีเมลอัตโนมัติ และไม่คืนสิทธิ์สมาชิกที่ถูกระงับแล้ว</p>
 <form onSubmit={e=>{e.preventDefault();void work(async()=>{await api(`${base}/invitations`,'POST',{email,days:7});setEmail('');await invitations();setMessage('เพิ่มคำเชิญแล้ว');});}}><label className="field">อีเมลที่เชิญ<input type="email" maxLength={254} required value={email} onChange={e=>setEmail(e.target.value)}/></label><button className="button secondary" disabled={busy}>เพิ่มคำเชิญ</button></form>
 <ul>{invites.map(i=><li key={i.email}>{i.email} · ถึง {new Date(i.expiresAt).toLocaleDateString('th-TH')} <button className="auth-text-button" disabled={busy} onClick={()=>void work(async()=>{await api(`${base}/invitations`,'DELETE',{email:i.email});await invitations(invitePage);})}>ถอนคำเชิญ</button></li>)}</ul>
 <div className="pagination"><button className="button secondary" disabled={busy||invitePage===1} onClick={()=>void work(()=>invitations(invitePage-1))}>ก่อนหน้า</button><span>หน้า {invitePage}</span><button className="button secondary" disabled={busy||!inviteMore} onClick={()=>void work(()=>invitations(invitePage+1))}>ถัดไป</button></div></section>
 <section><h3>ผลกระทบตามนโยบายที่บันทึก</h3><button className="button secondary" disabled={busy} onClick={()=>void work(async()=>setPreview(await api(`${base}/lifecycle-preview`)))}>ตรวจสมาชิกที่ถึงเกณฑ์</button>
 {preview&&<><p role="status">{preview.warning}</p><ul>{preview.data.map(r=><li key={r.userId}><strong>{r.email}</strong> · {r.reason==='unfinished_registration'?'สมัครไม่เสร็จ':'ถึงเกณฑ์ไม่ใช้งาน'}<br/><small>{r.lastReportedActivityAt?'มีประวัติรายงานกิจกรรมจาก Service':'ยังไม่มีข้อมูลกิจกรรมจาก Service ห้ามสรุปจาก Login อย่างเดียว'}</small></li>)}</ul>{!preview.data.length&&<p>ไม่มีสมาชิกที่ถึงเกณฑ์ในหน้านี้</p>}{preview.meta.hasMore&&<button className="button secondary" disabled={busy} onClick={()=>void work(async()=>setPreview(await api(`${base}/lifecycle-preview?cursor=${preview.meta.nextCursor}`)))}>ผลหน้าถัดไป</button>}</>}
 </section></>}{message&&<p role="status">{message}</p>}{error&&<p className="inline-error" role="alert">{error}</p>}
 </div>;
}
