# Google Branding สำหรับ CUSA SSO

หน้า `/` เป็นหน้าแนะนำบริการสาธารณะ อ่านได้โดยไม่ต้องล็อกอิน มีชื่อ CUSA SSO ผู้ให้บริการ วัตถุประสงค์ การใช้ข้อมูล Google และลิงก์นโยบาย ส่วนการล็อกอินอยู่ `/login` ชื่อผู้ส่ง OTP คือ CUSA SSO

## แก้ ownership จากข้อความใน Google Console

1. ใช้บัญชี Google ที่เป็น Owner หรือ Editor ของ Cloud project เปิด Google Search Console แล้วเพิ่ม **Domain property: `scicu-alumni.com`** ซึ่งครอบคลุม subdomain ของ SSO
2. คัดลอก DNS TXT ที่ Google ออกให้ เช่น `google-site-verification=...` แล้วเพิ่มใน DNS ที่เป็น authoritative ของ `scicu-alumni.com` หาก nameserver อยู่ HostAtom/Plesk ให้เพิ่มที่ DNS Settings ของโดเมนหลัก หากชี้ DNS ไปบริการอื่นให้เพิ่มที่บริการนั้น ไม่ใช่เพิ่มใน `.env`
3. กด Verify ใน Search Console จนสำเร็จ เก็บ TXT นี้ไว้ และให้บัญชีที่มีสิทธิ์ใน project เป็นเจ้าของที่ยืนยันแล้วของ property
4. ตามข้อความปฏิเสธที่ได้รับ รออย่างน้อย 24 ชั่วโมงหลังยืนยันสำเร็จก่อนส่งตรวจซ้ำ การเปลี่ยนโค้ดเว็บเพียงอย่างเดียวไม่ยืนยัน ownership

Google ให้ยืนยันโดเมนระดับที่จดทะเบียนได้และใช้บัญชีที่เกี่ยวข้องกับ project: [Brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), [Search Console ownership](https://support.google.com/webmasters/answer/9008080?hl=en)

## ค่าใน Google Auth Platform → Branding

| ช่อง | ค่า |
| --- | --- |
| App name | `CUSA SSO` |
| User support email | `support.scicualumni@gmail.com` โดยบัญชีที่ตั้งค่าต้องมีสิทธิ์ใช้อีเมลนี้ |
| Homepage | `https://sso.reunion.scicu-alumni.com/` |
| Privacy policy | `https://sso.reunion.scicu-alumni.com/privacy` |
| Terms of service | `https://sso.reunion.scicu-alumni.com/terms` |
| Authorized domains | `scicu-alumni.com` |
| OAuth callback ของ Web client | `https://sso.reunion.scicu-alumni.com/api/auth/google/callback` |

ใช้โลโก้เดียวกันบนเว็บและ consent screen: `web/public/cusa-sso.svg` เป็น wordmark ของระบบ CUSA SSO ที่เพิ่มในรอบนี้ และ `web/public/cusa-sso.png` เป็นไฟล์สำหรับอัปโหลด ไม่ใช่การอ้างว่าเป็นตราสมาคมอย่างเป็นทางการ หากใช้ตราสมาคมที่ได้รับอนุญาต ให้แทนที่ทั้งสองฝั่งพร้อมกัน หลีกเลี่ยงการใช้ไอคอน shield ทั่วไปเป็นโลโก้เพียงอย่างเดียว

หลัง deploy ให้เปิดหน้าแรก/นโยบาย/ข้อกำหนดในหน้าต่างที่ยังไม่ล็อกอิน ตรวจชื่อกับโลโก้ให้ตรง จากนั้นเลือก **I have fixed the issues** และส่งตรวจใหม่ หลังผ่านแล้วกด **Publish branding** หาก Console แสดงขั้นตอนนี้ ยังไม่ควรอ้างว่า Google อนุมัติจนกว่า Console จะแสดงผลสำเร็จ [คู่มือการจัดการ Branding](https://support.google.com/cloud/answer/15549049?hl=en)

Login ของสมาชิกขอเฉพาะ `openid email profile` บัญชี Gmail ผู้ส่ง OTP เชื่อมต่อด้วย OAuth แยกสำหรับ `gmail.send` ข้อกำหนดเรื่อง scope verification และ Publishing status ของ Gmail ต้องตรวจแยกจากการผ่าน branding
