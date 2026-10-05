# ข้อมูลผู้ใช้และสิทธิ์แต่ละ Service

ข้อมูลชื่อ–นามสกุลอยู่ที่บัญชีผู้ใช้ส่วนกลาง ส่วนหน่วยงานและ Role ผูกกับคู่ `(application_id, user_id)` ผู้ใช้คนเดียวจึงอยู่ฝ่าย HR และเป็น `approver` ในระบบลา แต่เป็น `viewer` ในระบบบัญชีได้ โดยไม่แชร์สิทธิ์ข้ามระบบ

## ใช้งานผ่านหน้าเว็บ

1. หน้า **ผู้ใช้งาน** → ปุ่มรายละเอียด: แก้ชื่อและนามสกุลแยกช่อง ข้อมูล Google `given_name`/`family_name` ใช้เป็นค่าเริ่มต้นตอนสร้างบัญชีใหม่ การล็อกอินครั้งต่อไปไม่ทับค่าที่แก้ไว้; บัญชีเดิมที่ไม่มีข้อมูลจะยังแสดง Google display name
2. หน้า **สิทธิ์แต่ละ Service** → เลือก Service ที่ลงทะเบียนไว้ → เพิ่ม Role เช่น `viewer`, `editor`, `approver` หรือรหัสที่กำหนดเอง พร้อมชื่อแสดงผลและคำอธิบาย
3. เพิ่มสมาชิก เลือกผู้ใช้ กรอกหน่วยงานของ Service และเลือก Role ได้ 1–20 รายการ ผู้ใช้จะมีข้อมูลหลัง Google Login ครั้งแรก
4. แก้ไข/ถอนสมาชิก หรือแก้ชื่อและคำอธิบาย Role ได้ รหัส Role เปลี่ยนไม่ได้และไม่ถูกนำกลับมาใช้ซ้ำหลังลบ ป้องกันระบบปลายทางตีความสิทธิ์เดิมผิด หาก Role ยังถูกใช้อยู่ให้เปลี่ยนสิทธิ์สมาชิกก่อนลบ

Role ของ Service ไม่ให้สิทธิ์ Admin ของ CUSA SSO แม้ตั้งชื่อว่า `admin` ผู้ดูแล CUSA SSO เท่านั้นที่เปลี่ยน profile, Role และสมาชิกได้ ต้องใช้ session ที่ผ่าน MFA และ Origin + CSRF token ตามปกติ การเป็น Admin ของ CUSA SSO ไม่ทำให้เข้า Service ได้โดยอัตโนมัติ

แต่ละ Service รองรับสูงสุด 100 Role ที่เปิดใช้งาน รายการสมาชิกค้นหาและแบ่งหน้าได้ ตัวเลือก Service และผู้ใช้ค้นหา/เปลี่ยนหน้าได้ เพื่อไม่จำกัดการเลือกเฉพาะ 100 รายการแรก

## API สำหรับผู้ดูแล

| Method | Path | ข้อมูล |
| --- | --- | --- |
| PATCH | `/api/admin/users/:id/profile` | `{firstName,lastName}` |
| GET | `/api/admin/applications/:applicationId/roles` | `{roles:[{id,applicationId,code,name,description}]}` |
| POST | `/api/admin/applications/:applicationId/roles` | `{code,name,description}` → `{role}` |
| PATCH | `/api/admin/applications/:applicationId/roles/:roleId` | `{code,name,description}`; code ต้องตรงค่าเดิม |
| DELETE | `/api/admin/applications/:applicationId/roles/:roleId` | soft revoke; 409 ถ้ามีสมาชิกใช้อยู่ |
| GET | `/api/admin/applications/:applicationId/members?page=1&limit=20&search=...` | `{members:[{userId,name,email,department,roleIds}],meta}` |
| PUT | `/api/admin/applications/:applicationId/members/:userId` | `{department,roleIds:[UUID,...]}` สร้าง/แทนที่สิทธิ์ทั้งหมดใน Service นี้ |
| DELETE | `/api/admin/applications/:applicationId/members/:userId` | ถอนสมาชิกและยกเลิก credentials ของคู่นี้ |

รหัส Role ใช้ `[a-z][a-z0-9_-]{0,47}`; ชื่อ/นามสกุลและชื่อ Role สูงสุด 100 ตัวอักษร; หน่วยงาน 150; คำอธิบาย 500; HTTP 400 สำหรับข้อมูลไม่ถูกต้อง/Role ข้าม Service, 403 สำหรับผู้ไม่ใช่ Admin, 404 สำหรับบัญชี/Service/Role ที่ไม่มีหรือถูกเพิกถอน, 409 สำหรับรหัสซ้ำหรือ Role ที่กำลังถูกใช้

## ข้อมูลสำหรับ Service ปลายทาง

ทั้ง introspection และ userinfo คืน `sub`, `roles`, `aud`, `scope` ของ Service นั้นเสมอ ส่วน `given_name`, `family_name`, `picture`, `department` คืนเมื่ออนุมัติ `profile` และอีเมลเมื่ออนุมัติ `email` ตาม [Consent contract](SSO-INTEGRATION.md) ไม่คืน platform admin role และไม่คืนสมาชิกของ Service อื่น

```json
{
  "active": true,
  "sub": "user-uuid",
  "email": "member@example.com",
  "name": "สมชาย ใจดี",
  "given_name": "สมชาย",
  "family_name": "ใจดี",
  "department": "ฝ่ายการเงิน",
  "roles": ["viewer", "approver"],
  "aud": "application-uuid",
  "scope": "identity:read profile email",
  "exp": 2000000000
}
```

ระบบปลายทางต้องตรวจ `active`, `aud`, `exp` และ Role ฝั่ง backend ทุก protected operation แล้วผูก Role กับสิ่งที่ทำได้ในระบบนั้น การสร้างชื่อ Role ไม่ได้สร้าง business permissions ให้อัตโนมัติ ไม่เชื่อ Role จาก browser หรือใช้หน่วยงาน/ชื่อผู้ใช้เป็นหลักฐานสิทธิ์

Authorization code, token exchange, introspection และ userinfo ตรวจสมาชิกที่ยังใช้งานและอย่างน้อยหนึ่ง Role ที่ยังใช้งาน ถ้าไม่ผ่าน จะไม่ออก code/token หรือคืน token inactive ผู้ใช้ที่ยังไม่ได้รับสิทธิ์จะเห็นหน้าแจ้งให้ติดต่อผู้ดูแล เมื่อกำหนดสิทธิ์ใหม่ให้เริ่ม flow จาก Service อีกครั้ง

การเปลี่ยนหน่วยงาน/Role หรือถอนสมาชิกจะ revoke access tokens และลบ authorization codes เฉพาะคู่ user–Service ใน transaction เดียวกับ Audit Outbox; Service อื่นยังใช้งานได้ รายการ Role และ membership มี composite foreign keys ป้องกันการอ้าง Role ข้าม Service การนำบัญชีกลับเข้า allowlist ไม่คืน Service membership เดิมโดยอัตโนมัติ

Introspection cache อาจตอบสิทธิ์เดิมได้ไม่เกิน 5 วินาทีตามค่าระบบ ตั้ง `INTROSPECTION_CACHE_SECONDS=0` เมื่อต้องตรวจ DB ทุกครั้ง หากระบบปลายทาง cache เพิ่ม ระยะ delay จะสะสม

## Migration และการนำขึ้นระบบ

ต้องรัน `npm run db:migrate` ด้วยบัญชี migration ก่อนเปิด backend เวอร์ชันนี้ ไฟล์ `002_service_roles.sql` เพิ่ม `users.first_name`, `users.last_name`, `application_roles`, `application_memberships`, `application_member_roles` และ indexes

**ค่าเริ่มต้นยังไม่มีการให้สิทธิ์เข้า Service อัตโนมัติ:** ผู้ใช้เดิมต้องได้รับสมาชิกและ Role จาก Admin ก่อนใช้ SSO กับ Service นั้น token เดิมของผู้ที่ยังไม่ได้รับสิทธิ์จะไม่ผ่านการตรวจหลังเปลี่ยนเวอร์ชัน (ภายในอายุ cache สูงสุด 5 วินาที)

Runtime ต้องมีสิทธิ์ SELECT/INSERT/UPDATE/DELETE ตามการทำงานของสามตารางใหม่ แต่ไม่มี DDL และยังห้าม UPDATE/DELETE `audit_logs` เช่นเดิม Schema และ migration ได้ทดสอบบน MariaDB ในเครื่อง; ไม่ได้รันกับ host จริง


## บัญชีภายในและสมาชิกจาก Service — Migration 009

ตัวตน `users` เป็นข้อมูลยืนยันตัวตนร่วม แต่ไม่ได้ให้สิทธิ์ระบบกลางโดยตัวเอง:

- `account_type=internal`: บัญชีเดิมทั้งหมด ยังคงต้องมีอีเมลใน Allowlist ทุกครั้งที่ตรวจ session/token การถอน Allowlist ไม่เปลี่ยนเป็นบัญชี public และไม่เปิดทางสมัครหลบข้อห้าม
- `account_type=service`: สร้างผ่านคำขอของ Service ที่เปิดรับเท่านั้น ได้ platform role `service` ไม่มีสิทธิ์ Admin และไม่อยู่ในรายการผู้ใช้งานภายใน เมนูส่วนตัวมีเฉพาะความปลอดภัยและเซสชัน
- ผู้ใช้จาก Service ต้องเริ่ม Google Login จากระบบลูกที่ลงทะเบียน callback ไว้ การเข้าจากหน้า Login กลางโดยไม่มี Service ไม่สร้างบัญชี public
- การเพิ่มอีเมลผ่าน Allowlist โดย Admin เป็นการรับเข้าภายในอย่างชัดเจนและมี Audit พร้อมยกเลิกเซสชันเดิมให้ล็อกอินใหม่; การรับเข้าภายในไม่คืนสมาชิก/Role ของ Service ที่ถูกถอน
- Google `sub` เป็นตัวผูก identity เดิม ไม่รวมบัญชีอัตโนมัติจากเบอร์/LINE/อีเมลที่ตรงกัน ถ้า Google subject ต่างกันแต่อีเมลชนกัน จะปฏิเสธ
- หน้า **ผู้ใช้งานภายใน** แยกจาก **สิทธิ์แต่ละ Service** ซึ่งแสดงประเภทบัญชีและสถานะ pending/active/ระงับ รายการนี้รวมสมาชิกที่ถูกระงับเพื่อให้ Admin ตรวจและคืนสิทธิ์โดยเจตนาได้
- ในหน้าต่างเพิ่มสมาชิก เลือกประเภทบัญชี “ผู้ใช้งานภายใน CUSA” หรือ “บัญชีที่สมัครผ่าน Service” ก่อนค้นหา การเลือกบัญชีจาก Service อื่นเพื่อเพิ่มสมาชิกต้องเป็นการกระทำของ Admin โดยตรงและมี Audit
- การจัดการนโยบายยังใช้ Admin กลางและ fresh Passkey/TOTP เท่านั้น Role ของระบบลูกไม่ให้สิทธิ์จัดการ SSO; รุ่นนี้ยังไม่เปิด delegated administrator

### ตั้งนโยบายรับสมาชิก

1. สร้าง Role พื้นฐานของ Service ก่อน และตรวจฝั่งระบบลูกว่า Role นั้นไม่มีอำนาจผู้ดูแล
2. ที่แอปพลิเคชัน → **ตั้งค่าข้อมูลและ Consent** กำหนดรายการข้อมูลสูงสุดที่ขอได้และวัตถุประสงค์
3. เปิด **นโยบายสมาชิกและการรับสมัคร** เลือก `closed` (ค่าเริ่มต้น), `invite` หรือ `open` และเลือก Role เริ่มต้น
4. หากเป็น `invite` เพิ่มอีเมล Google ในส่วนคำเชิญ วันหมดอายุใน UI คือ 7 วัน; API กำหนด 1–30 วัน ไม่มีการส่งข้อความให้บุคคลภายนอกโดยอัตโนมัติ
5. เลือกการบังคับยืนยันเบอร์/ผูก LINE และระดับ MFA (`standard` ตามนโยบายบัญชี หรือ `strong` ซึ่งต้องใช้ Passkey/TOTP) ระบบไม่ลดความปลอดภัยเดิมของบัญชีที่มี Authenticator
6. เลือกข้อมูลจำเป็นที่ผู้ใช้ต้องอนุญาตก่อนใช้ Service ซึ่งเป็น subset ของรายการข้อมูลสูงสุด การบังคับผูกเบอร์กับการอนุญาตส่งเบอร์เป็นคนละนโยบาย; ใช้ `phone:match` แทน `phone` หากต้องการเพียงตรวจตรงกัน
7. ตั้งเพดานสมาชิกสมัครเอง (รวม pending ที่ยังไม่ถูกถอน) ค่าเริ่มต้น 1,000 คน และอายุ pending 14 วัน ค่าเหล่านี้เป็นนโยบายระบบ ไม่ใช่อายุที่กฎหมายกำหนด
8. บันทึกด้วย fresh MFA การบันทึกเพิ่ม version และยกเลิก consent/code/token รุ่นก่อนภายในขอบเขต introspection cache; ไม่เพิ่มสิทธิ์ให้ Token เก่าย้อนหลัง

การสมัครใหม่สร้างสมาชิก `pending` โดยยังไม่มี Role การยืนยัน MFA และ Consent สำเร็จจึงเปลี่ยนเป็น `active` และรับ Role เริ่มต้นใน transaction เดียวกับการออก code และ Audit Outbox หากปฏิเสธจะไม่มีสิทธิ์เข้า Service คำขอ pending ที่หมดอายุ/ถูกถอนจะไม่คืนสิทธิ์ด้วยการสมัครใหม่ ต้องให้ Admin พิจารณา

ปิดรับสมัครหรือถอน/หมดอายุคำเชิญ จะหยุดการสมัครที่ยัง pending แม้ผู้ใช้เปิดหน้าค้างอยู่ สมาชิก active เดิมยังใช้ได้ตามสิทธิ์ ต้องถอนสมาชิกแยกหากต้องการระงับคนนั้น

การผูก LINE ยังคงต้องตั้ง Authenticator/Recovery codes และยืนยันระดับ strong ก่อนจัดการวิธีสำรอง หน้าตรวจเงื่อนไขอธิบายขั้นตอนนี้และพาไปหน้าความปลอดภัย โดยเก็บ returnTo ที่ตรวจสอบแล้วกลับมาดำเนิน Consent ต่อ การเข้าเงื่อนไขจาก UI ไม่เพียงพอ: backend ตรวจซ้ำเมื่อออก code, แลก token และอ่าน token ทุกครั้ง

หาก Service เปิดห้องรอคิว ต้องมีสิทธิ์คิวเดิมระหว่างทำขั้นตอนสมัคร/ผูกข้อมูล ระบบจะใช้สิทธิ์เมื่อพร้อมเข้าสู่ Consent โดยไม่ต่ออายุคิวหรือข้ามคิว หากทำเกินเวลาต้องเข้าคิวใหม่ตามปกติ

### บัญชีไม่ใช้งาน: โหมดตรวจผลกระทบ

กำหนด inactiveDays (30–3650 วัน หรือเว้นว่างเพื่อปิด), noticeDays และ recoveryDays (7–90 วัน) แยกตาม Service ได้ **รุ่นนี้เป็น preview เท่านั้น ไม่มีการส่งเตือน/ระงับ/ลบบัญชีอัตโนมัติ** noticeDays/recoveryDays เป็นค่าร่างเพื่อพิจารณานโยบาย ก่อนเปิดใช้งานขั้นทำลายข้อมูลในอนาคตต้องตกลงวัตถุประสงค์/ฐานกฎหมาย/กิจกรรมที่ใช้วัด/ช่วงแจ้งเตือน/ภาระเก็บข้อมูล/สำเนาที่ระบบลูกและ backup ให้ครบ

รายงานแสดงคำขอ pending ที่หมดอายุ และสมาชิก active ที่ถึงเกณฑ์ตาม `last_activity_at` (ใช้ created_at เมื่อยังไม่มี) เป็น keyset pagination ด้วย user_id การอนุมัติ Consent ที่สำเร็จและ API รายงานกิจกรรมเท่านั้นที่อัปเดตเวลา ไม่อัปเดตจาก introspection, userinfo, polling หรือ cron รายงานแสดงว่ามีข้อมูลกิจกรรมจากระบบลูกหรือไม่ ห้ามใช้เวลาล็อกอินตัดสินว่าผู้ใช้ไม่ได้ทำงานในระบบลูกอย่างเดียว

ใช้ปุ่มถอนสมาชิกเดิมเพื่อระงับเฉพาะ Service หลังตรวจทานได้ โดยยังคง tombstone ป้องกันสมัครหลบการระงับ ไม่ลบตัวตนร่วม ไม่ลบสมาชิก Service อื่น ไม่ลบหลักฐาน MFA หรือ Audit ผ่านงานนี้ ตัวตนที่ไม่มีสมาชิกเหลือยังไม่ถูกกวาดทิ้งอัตโนมัติ

### API เพิ่มเติม

ทุก `/admin/*` ต้องเป็น Admin กลาง การเขียนต้องใช้ fresh MFA + Origin + CSRF token

| Method | Path | ข้อมูล |
| --- | --- | --- |
| GET | `/api/admin/service-users?page=1&limit=20&search=...` | ค้นหาบัญชีจาก Service เพื่อให้ Admin เพิ่มสมาชิกโดยเจตนา; แยกจาก `/api/admin/users` ที่แสดงเฉพาะบัญชีภายใน |
| GET/PUT | `/api/admin/applications/:applicationId/access-policy` | GET คืน policy+version+lifecycleMode; PUT ส่ง policy พร้อม expectedVersion ป้องกันเขียนทับการแก้ไขพร้อมกัน |
| GET/POST/DELETE | `/api/admin/applications/:applicationId/invitations` | GET page/limit; POST `{email,days}`; DELETE `{email}` |
| GET | `/api/admin/applications/:applicationId/lifecycle-preview?limit=50&cursor=...` | `{mode,policy,data,meta,warning}`; อ่านอย่างเดียว |
| GET/POST | `/api/sso/enrollment` | GET query `returnTo`, POST `{returnTo}`; full session, Origin+CSRF เมื่อ POST; คืนข้อมูลเงื่อนไขและสถานะของผู้ใช้เอง |
| POST | `/api/sso/activity` | Backend key ที่มี `member:activity`; `{sub,eventId:UUID}`; จำกัดสมาชิกใน Service ของ key |

`activity` ต้องส่งจาก Backend เมื่อผู้ใช้ทำกิจกรรมจริงเท่านั้น ไม่ส่งจาก Browser หรือ timer ใช้ eventId เดิมเมื่อ retry ภายใน 30 วัน ระบบใช้เวลาที่รับคำขอ ไม่เชื่อเวลาจาก caller บันทึกได้สูงสุดหนึ่งครั้งต่อสมาชิกต่อ 5 นาที; คำขอภายในช่วงนี้คืน `{ok:true,recorded:false,retryAfter:300}` โดยไม่เพิ่มแถว คำขอซ้ำที่เคยบันทึกคืน duplicate:true และไม่เลื่อนเวลา API นี้ไม่เปลี่ยนสถานะสมาชิก ไม่คืนสิทธิ์ผู้ถูกระงับ และไม่เป็นหลักฐาน KYC

### นำขึ้น Host

รัน migration ถึง `009_service_accounts.sql` ด้วยบัญชีที่มีสิทธิ์ migration/CREATE VIEW แล้วให้ runtime SELECT บน `sso_login_accounts` และสิทธิ์ตารางใหม่ตาม runtime-grants.sql View ใช้ SQL SECURITY INVOKER ไม่ยืมสิทธิ์ของผู้รัน migration มีค่าเริ่มต้นปิดรับทั้งหมด ผู้ใช้และสมาชิกเดิมยังคงเงื่อนไขเดิม ไม่มีค่า .env เพิ่ม
