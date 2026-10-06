import type { ReactNode } from 'react';
import { ArrowDown, Fingerprint, Globe2, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import { Brand } from './ui';
import { LegalLinks } from './LegalLinks';
import '../views/auth.css';

export function AuthLayout({ children, footer, wide = false }: { children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return <div className="auth-page auth-layout">
    <main className={`auth-main${wide ? ' auth-main-wide' : ''}`}>
      <aside className="auth-story">
        <header className="auth-brand"><Brand /><span>บัญชีเดียว เชื่อมต่อบริการของคุณ</span></header>
        <div className="auth-story-copy"><span className="story-label"><Sparkles size={14} /> YOUR CONNECTED SPACE</span><h2>ทุกบริการที่คุณใช้<br /><em>เริ่มต้นที่เดียว</em></h2><p>พื้นที่สำหรับบัญชีของคุณ<br />เชื่อมต่อบริการ และดูแลทุกการเข้าใช้งาน</p></div>
        <div className="auth-journey" aria-label="ขั้นตอนเข้าใช้งาน">
          <div className="journey-item"><span className="journey-icon"><Globe2 size={22} /></span><div><small>01 · เริ่มต้น</small><strong>บัญชี Google ของคุณ</strong></div><span className="journey-dot" /></div>
          <ArrowDown className="journey-arrow" size={18} aria-hidden="true" />
          <div className="journey-item featured"><span className="journey-icon"><Fingerprint size={25} /></span><div><small>02 · ยืนยันตัวตน</small><strong>เพิ่มความมั่นใจอีกหนึ่งขั้น</strong></div><ShieldCheck size={21} /></div>
          <ArrowDown className="journey-arrow" size={18} aria-hidden="true" />
          <div className="journey-item"><span className="journey-icon"><LockKeyhole size={22} /></span><div><small>03 · เชื่อมต่อ</small><strong>พร้อมเข้าใช้บริการของคุณ</strong></div></div>
        </div>
        <div className="auth-story-footer"><ShieldCheck size={17} /><span>คุณเป็นผู้ดูแลการเข้าถึงบัญชีของคุณ</span></div>
      </aside>
      <div className="auth-form-area"><section className="auth-card">{children}</section>{footer}
        <p className="auth-trust"><ShieldCheck size={16} aria-hidden="true" />ดูแลบัญชีของคุณในทุกการเข้าใช้งาน</p>
      </div>
    </main>
    <footer className="auth-footer"><LegalLinks /><span>© {new Date().getFullYear()} CUSA SSO · สมาคมนิสิตเก่าวิทยาศาสตร์ จุฬาลงกรณ์มหาวิทยาลัย</span></footer>
  </div>;
}
