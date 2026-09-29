import { Brand } from '../components/ui';
import { LegalLinks } from '../components/LegalLinks';
import './home.css';
export function Home() {
  return <div className="home-page"><header><Brand/><a href="/login">เข้าสู่ระบบ</a></header>
    <main><p className="home-eyebrow">สมาคมนิสิตเก่าวิทยาศาสตร์ จุฬาลงกรณ์มหาวิทยาลัย</p>
      <h1>CUSA SSO</h1><p className="home-lead">บัญชีเดียว เชื่อมต่อบริการของสมาคม</p>
      <p className="home-description">ระบบเข้าสู่ระบบส่วนกลางสำหรับสมาชิกและผู้ดูแลที่ได้รับอนุญาต ใช้บัญชี Google และการยืนยันอีกขั้นเพื่อเข้าถึงเว็บไซต์และบริการที่สมาคมลงทะเบียนไว้</p>
      <a className="home-login" href="/login">เข้าสู่ระบบด้วยบัญชี Google <span aria-hidden="true">→</span></a>
      <section aria-labelledby="google-data"><h2 id="google-data">ข้อมูล Google ที่เราใช้</h2>
        <p>CUSA SSO ใช้ชื่อ อีเมล รูปโปรไฟล์ และรหัสบัญชี Google เพื่อยืนยันตัวตน แสดงข้อมูลบัญชี และตรวจสอบสิทธิ์การเข้าถึงบริการ ข้อมูลที่ส่งให้แต่ละ Service ขึ้นอยู่กับสิทธิ์ที่ผู้ดูแลกำหนด</p>
        <p>การเข้าสู่ระบบของสมาชิกไม่ขอสิทธิ์อ่านกล่องจดหมาย บัญชีอีเมลผู้ส่งที่ผู้ดูแลเชื่อมต่อแยกต่างหากใช้สิทธิ์ Gmail ส่งอีเมลสำหรับส่งรหัส OTP</p>
        <p>อ่านรายละเอียดการใช้ข้อมูลและสิทธิของคุณได้ใน<a href="/privacy">นโยบายความเป็นส่วนตัว</a></p></section>
      <section aria-labelledby="contact"><h2 id="contact">ผู้ให้บริการและติดต่อเรา</h2>
        <p>สมาคมนิสิตเก่าวิทยาศาสตร์ จุฬาลงกรณ์มหาวิทยาลัย<br/>คณะวิทยาศาสตร์ ถนนพญาไท แขวงวังใหม่ เขตปทุมวัน กรุงเทพมหานคร 10330</p>
        <p><a href="tel:022527634">02-252-7634</a><br/><a href="mailto:support.scicualumni@gmail.com">support.scicualumni@gmail.com</a></p></section>
    </main><footer><LegalLinks/><span>© {new Date().getFullYear()} CUSA SSO</span></footer></div>;
}
