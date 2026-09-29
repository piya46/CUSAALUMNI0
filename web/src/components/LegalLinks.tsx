import './legal-links.css';

// Keep an in-progress Google/MFA/SSO flow in its original tab, without copying its URL.
export function LegalLinks() {
  return <nav className="legal-links" aria-label="นโยบายและข้อกำหนด">
    <a href="/privacy" target="_blank" rel="noopener noreferrer">นโยบายความเป็นส่วนตัว<span className="legal-link-hint"> (เปิดแท็บใหม่)</span></a>
    <span aria-hidden="true">·</span>
    <a href="/terms" target="_blank" rel="noopener noreferrer">ข้อกำหนดการใช้งาน<span className="legal-link-hint"> (เปิดแท็บใหม่)</span></a>
  </nav>;
}
