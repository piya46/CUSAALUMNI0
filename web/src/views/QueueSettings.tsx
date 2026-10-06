import { useState } from 'react';
import { api } from '../models/api';
import './waiting-room.css';
type Settings = { enabled: boolean; rate: number; capacity: number; ipLimit: number };
export function QueueSettings({ applicationId }: { applicationId: string }) {
  const [value,setValue] = useState<Settings>();
  const [open,setOpen] = useState(false), [busy,setBusy] = useState(false), [message,setMessage] = useState('');
  async function load() {
    if (open) { setOpen(false); return; }
    setBusy(true); setMessage('');
    try { setValue(await api(`/admin/applications/${applicationId}/queue`)); setOpen(true); }
    catch(e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setMessage('');
    try { await api(`/admin/applications/${applicationId}/queue`,'PUT',value); setMessage('บันทึกการตั้งค่าคิวแล้ว'); }
    catch(e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="queue-settings"><button className="button secondary settings-toggle" aria-expanded={open} disabled={busy} onClick={load}>{open?'ปิดการตั้งค่าคิว':'ตั้งค่าห้องรอคิว'}</button>
    {open&&value&&<form onSubmit={e=>{e.preventDefault();void save();}}>
      <p>คิว FIFO ใช้ Redis และยังตรวจสิทธิ์/MFA ครบทุกขั้นตอน หาก Redis ไม่พร้อม ระบบจะหยุดให้ผ่านคิว</p>
      <label className="queue-toggle"><input type="checkbox" checked={value.enabled} onChange={e=>setValue({...value,enabled:e.target.checked})}/>เปิดห้องรอคิวสำหรับ Service นี้</label>
      <label className="field">ปล่อยเข้าล็อกอินสูงสุดต่อวินาที<input type="number" min={1} max={100} value={value.rate} required onChange={e=>setValue({...value,rate:Number(e.target.value)})}/></label>
      <label className="field">จำนวนตั๋วสูงสุดที่เก็บไว้<input type="number" min={100} max={20000} value={value.capacity} required onChange={e=>setValue({...value,capacity:Number(e.target.value)})}/></label>
      <label className="field">จำนวนเบราว์เซอร์ต่อเครือข่ายใน 1 ชั่วโมง<input type="number" min={1} max={100} value={value.ipLimit} required onChange={e=>setValue({...value,ipLimit:Number(e.target.value)})}/></label>
      <small>ผู้ใช้ร่วม Wi-Fi/VPN อาจมี IP เดียวกัน ควรกำหนดโควตาให้เหมาะสม · คิวรอมีอายุ 1 ชั่วโมง หลังได้สิทธิ์มีเวลา 15 นาที · 1 บัญชีผ่านคิวได้ 1 ครั้งต่อนาทีต่อ Service</small>
      <button className="button primary" disabled={busy}>{busy?'กำลังบันทึก…':'บันทึกการตั้งค่าคิว'}</button>
    </form>}{message&&<p role="status">{message}</p>}
  </div>;
}
