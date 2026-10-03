import { useEffect, useState } from 'react';
import { Clock3, ShieldCheck } from 'lucide-react';
import { Brand } from '../components/ui';
import { LegalLinks } from '../components/LegalLinks';
import './auth.css';
import './waiting-room.css';

type Ticket = { status: string; reference?: string; position?: number; total?: number; etaSeconds?: number;
  application?: { name: string; origin: string }; next?: string; restartFlow?: boolean };
export default function WaitingRoom() {
  const [ticket, setTicket] = useState<Ticket>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    document.title = 'ห้องรอคิว | CUSA SSO';
    const requested = new URLSearchParams(window.location.search).get('returnTo');
    if (!requested?.startsWith('/api/sso/authorize?')) { setError('กรุณาเริ่มเข้าสู่ระบบจาก Service ที่ต้องการใช้งาน'); return; }
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      let delay = 10000;
      try {
        const response = await fetch('/api/queue/visit', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-CUSA-Queue': '1' },
          body: JSON.stringify({ returnTo: requested }), signal: controller.signal });
        const body = await response.json();
        if (stopped) return;
        if (!response.ok) {
          setError(body.error || 'ยังตรวจสอบคิวไม่ได้ กรุณารอสักครู่');
          delay = Math.max(10000, Math.min(60000, Number(response.headers.get('Retry-After') || 10)*1000));
          if (![429,503].includes(response.status)) return;
        } else {
          setError(''); setTicket(body);
          if (body.status === 'completed') return;
          if (body.status === 'admitted' && body.restartFlow) return;
          // Only navigate to the server's same-origin authorization endpoint.
          if (['admitted','disabled'].includes(body.status) && typeof body.next==='string' && body.next.startsWith('/api/sso/authorize?')) {
            window.location.replace(body.next); return;
          }
        }
      } catch {
        if (stopped) return;
        setError('การเชื่อมต่อขัดข้อง ระบบจะตรวจคิวใหม่ให้อัตโนมัติ');
      }
      if (!stopped) timer = setTimeout(poll, delay + Math.floor(Math.random()*1000));
    }
    void fetch('/api/queue/session',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
      .then(response=>{if(!response.ok)throw new Error('Queue unavailable');if(!stopped)void poll();})
      .catch(()=>{if(!stopped)setError('ยังเริ่มห้องรอคิวไม่ได้ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่');});
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [attempt]);
  return <div className="auth-page"><main className="auth-main"><header className="auth-brand"><Brand/></header><section className="auth-card waiting-card">
    <div className="auth-state-icon"><Clock3 size={26}/></div><h1>{ticket?.status==='completed'?'ดำเนินการผ่านคิวแล้ว':ticket?.status==='admitted'?'ถึงคิวของคุณแล้ว':'ห้องรอคิว'}</h1>
    <p className="auth-description">{ticket?.application?.name || 'กำลังตรวจสอบ Service'}{ticket?.application && <small className="waiting-origin">{ticket.application.origin}</small>}</p>
    {ticket?.status==='admitted'&&ticket.restartFlow&&ticket.application ? <><p>เนื่องจากรอคิวมาระยะหนึ่ง กรุณาเริ่มคำขอเข้าสู่ระบบใหม่จาก Service ภายใน 15 นาที สิทธิ์คิวเดิมยังอยู่ในเบราว์เซอร์นี้</p><a className="button primary full-width" href={ticket.application.origin}>กลับไปยัง {ticket.application.name}</a></> : ticket?.status==='completed' ? <p>คำขอนี้ดำเนินการไปแล้ว หากต้องการเข้าใช้งานอีกครั้ง กรุณาเริ่มจาก Service ปลายทาง</p> : <>
      <p>ระบบจะพาไปเข้าสู่ระบบเมื่อถึงคิว กรุณาเปิดหน้านี้ไว้</p>
      {ticket?.reference && <p className="otp-reference">หมายเลขอ้างอิง <strong>{ticket.reference}</strong></p>}
      {ticket?.status==='waiting' && <div className="waiting-stats" role="status" aria-live="polite"><div><span>ลำดับคิว</span><strong>{ticket.position?.toLocaleString('th-TH')}</strong></div><div><span>รอทั้งหมด</span><strong>{ticket.total?.toLocaleString('th-TH')}</strong></div><p>เวลาประมาณ {Math.max(1,Math.ceil((ticket.etaSeconds??0)/60))} นาที · อาจนานขึ้นตามภาระระบบ</p></div>}
      <p className="auth-note"><ShieldCheck size={18}/><span>การรีเฟรชหรือเปิดหลายแท็บไม่เพิ่มสิทธิ์คิว<br/>ยังต้องยืนยัน Google และ MFA เมื่อถึงคิว</span></p>
    </>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    {error && <button className="button secondary full-width" onClick={()=>setAttempt(a=>a+1)}>ตรวจสอบอีกครั้ง</button>}
    <a className="auth-text-button" href="/">กลับหน้าหลัก CUSA SSO</a>
  </section></main><footer className="auth-footer"><LegalLinks/></footer></div>;
}
