import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Brand } from './ui';
import { LegalLinks } from './LegalLinks';
import '../views/auth.css';

export function AuthLayout({ children, footer, wide = false }: { children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return <div className="auth-page">
    <main className={`auth-main${wide ? ' auth-main-wide' : ''}`}>
      <header className="auth-brand"><Brand /><span>บัญชีเดียว เชื่อมต่อบริการของคุณ</span></header>
      <section className="auth-card">{children}</section>{footer}
      <p className="auth-trust"><ShieldCheck size={16} aria-hidden="true" />ดูแลบัญชีของคุณในทุกการเข้าใช้งาน</p>
    </main>
    <footer className="auth-footer"><LegalLinks /><span>© {new Date().getFullYear()} CUSA SSO · สมาคมนิสิตเก่าวิทยาศาสตร์ จุฬาลงกรณ์มหาวิทยาลัย</span></footer>
  </div>;
}
