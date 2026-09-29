import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, Database, LockKeyhole } from 'lucide-react';
import { Brand } from '../components/ui';
import { LegalLinks } from '../components/LegalLinks';
import './install.css';

type Details = { database: string; host: string; adminEmail: string; databaseVersion: string };
class SetupError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}
export default function Install() {
  const [token, setToken] = useState('');
  const [details, setDetails] = useState<Details | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { document.title = 'ติดตั้งระบบ | CUSA SSO'; }, []);

  async function submit(event: FormEvent, run = false) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch(`/api/install/${run ? 'run' : 'check'}`, {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(run ? { confirm: confirmed } : {}),
      });
      const result = await response.json().catch(() => { throw new SetupError('เซิร์ฟเวอร์ไม่ตอบกลับตามที่คาดไว้ กรุณาตรวจ Node.js ใน Plesk'); });
      if (!response.ok) throw new SetupError(result.error || 'ไม่สามารถดำเนินการได้', result.code);
      setDetails(result);
      if (run) { setDone(true); setToken(''); }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'เชื่อมต่อไม่ได้ กรุณาลองอีกครั้ง');
      if (error instanceof SetupError && ['INSTALL_LOCKED', 'NOT_FOUND'].includes(error.code ?? '')) {
        setClosed(true); setToken(''); setDetails(null);
      }
    } finally { setBusy(false); }
  }

  return <div className="install-page"><main className="install-main">
    <header><Brand /><span className="install-label">ตั้งค่าครั้งแรก</span></header>
    <section className="install-card" aria-busy={busy}>
      <div className={`install-icon ${done ? 'complete' : ''}`}>{done ? <CheckCircle2 size={26} /> : <Database size={26} />}</div>
      <h1>{done ? 'ติดตั้งเรียบร้อยแล้ว' : closed ? 'ปิดการติดตั้งแล้ว' : details ? 'ตรวจสอบก่อนติดตั้ง' : 'ติดตั้ง CUSA SSO'}</h1>
      <p className="install-description">{done ? 'สร้างตารางและกำหนดผู้ดูแลคนแรกแล้ว ระบบล็อกการติดตั้งซ้ำโดยอัตโนมัติ' : 'สร้างตารางในฐานข้อมูลที่เตรียมไว้บน Plesk และกำหนดผู้ดูแลระบบคนแรก'}</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {done ? <div role="status">
        <p>ผู้ดูแลระบบ: <strong>{details?.adminEmail}</strong></p>
        <ol className="install-steps"><li>ตั้ง <code>INSTALL_ENABLED=false</code> และลบค่า <code>INSTALL_TOKEN</code> ใน Environment บน Host</li><li>เปลี่ยนบัญชี DB เป็นบัญชีสำหรับใช้งานประจำ หากแยกจากบัญชีติดตั้ง</li><li>กด <strong>Restart App</strong> ใน Plesk แล้วเข้าสู่ระบบด้วย Google</li></ol>
        <a className="button primary full-width" href="/login">ไปหน้าเข้าสู่ระบบ</a>
      </div> : closed ? <a className="button secondary full-width" href="/login">ไปหน้าเข้าสู่ระบบ</a> : details ? <form onSubmit={event => void submit(event, true)}>
        <dl className="install-details"><div><dt>Database</dt><dd>{details.database}</dd></div><div><dt>Host</dt><dd>{details.host}</dd></div><div><dt>MariaDB</dt><dd>{details.databaseVersion}</dd></div><div><dt>อีเมลผู้ดูแล</dt><dd>{details.adminEmail}</dd></div></dl>
        <p className="install-note">หากอีเมลไม่ถูกต้อง ให้แก้ BOOTSTRAP_ADMIN_EMAIL บน Host แล้ว Restart App การตรวจสอบนี้ยังไม่ทดสอบ Google Login หรือส่งอีเมลจริง</p>
        <label className="install-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} required /><span>ยืนยันฐานข้อมูลและอีเมลผู้ดูแลข้างต้น เพื่อสร้างตารางและสิทธิ์เริ่มต้น</span></label>
        <button className="button primary full-width" disabled={busy || !confirmed}>{busy ? 'กำลังติดตั้ง… กรุณารอสักครู่' : 'สร้างตารางและติดตั้งระบบ'}</button>
        <button className="button secondary full-width" type="button" disabled={busy} onClick={() => { setDetails(null); setConfirmed(false); setError(''); }}>กลับไปตรวจสอบใหม่</button>
      </form> : <form onSubmit={event => void submit(event)}>
        <label className="field">รหัสติดตั้ง<input type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value.trim())} required minLength={43} maxLength={43} disabled={busy} aria-describedby="install-token-help" /></label>
        <p id="install-token-help" className="install-note">ใช้ค่า INSTALL_TOKEN จาก .env หรือ Environment ใน Plesk ที่ผู้ดูแลตั้งไว้</p>
        <button className="button primary full-width" disabled={busy || token.length !== 43}>{busy ? 'กำลังตรวจสอบ…' : 'ตรวจสอบความพร้อม'}</button>
        <p className="install-security"><LockKeyhole size={15} />รหัสติดตั้งไม่ถูกเก็บใน URL หรือที่เก็บข้อมูลของเบราว์เซอร์</p>
      </form>}
    </section>
    <footer><LegalLinks /><span>© {new Date().getFullYear()} CUSA SSO</span></footer>
  </main></div>;
}
