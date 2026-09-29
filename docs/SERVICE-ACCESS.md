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

ทั้ง introspection และ userinfo คืน `given_name`, `family_name`, `department`, `roles` (array ของรหัส) และ `aud` ของ Service นั้นเท่านั้น ไม่คืน platform admin role และไม่คืนสมาชิกของ Service อื่น

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
  "scope": "identity:read",
  "exp": 2000000000
}
```

ระบบปลายทางต้องตรวจ `active`, `aud`, `exp` และ Role ฝั่ง backend ทุก protected operation แล้วผูก Role กับสิ่งที่ทำได้ในระบบนั้น การสร้างชื่อ Role ไม่ได้สร้าง business permissions ให้อัตโนมัติ ไม่เชื่อ Role จาก browser หรือใช้หน่วยงาน/ชื่อผู้ใช้เป็นหลักฐานสิทธิ์

Authorization code, token exchange, introspection และ userinfo ตรวจสมาชิกที่ยังใช้งานและอย่างน้อยหนึ่ง Role ที่ยังใช้งาน ถ้าไม่ผ่าน จะไม่ออก code/token หรือคืน token inactive ผู้ใช้ที่ยังไม่ได้รับสิทธิ์จะเห็นหน้าแจ้งให้ติดต่อผู้ดูแล เมื่อกำหนดสิทธิ์ใหม่ให้เริ่ม flow จาก Service อีกครั้ง

การเปลี่ยนหน่วยงาน/Role หรือถอนสมาชิกจะ revoke access tokens และลบ authorization codes เฉพาะคู่ user–Service ใน transaction เดียวกับ Audit Outbox; Service อื่นยังใช้งานได้ รายการ Role และ membership มี composite foreign keys ป้องกันการอ้าง Role ข้าม Service การนำบัญชีกลับเข้า allowlist ไม่คืน Service membership เดิมโดยอัตโนมัติ

Introspection cache อาจตอบสิทธิ์เดิมได้ไม่เกิน 5 วินาทีตามค่าระบบ ตั้ง `INTROSPECTION_CACHE_SECONDS=0` เมื่อต้องตรวจ DB ทุกครั้ง หากระบบปลายทาง cache เพิ่ม ระยะ delay จะสะสม

## Migration และการนำขึ้นระบบ

ต้องรัน `npm run db:migrate` ด้วยบัญชี migration ก่อนเปิด backend เวอร์ชันนี้ ไฟล์ `002_service_roles.sql` เพิ่ม `users.first_name`, `users.last_name`, `application_roles`, `application_memberships`, `application_member_roles` และ indexes

**ไม่มีการให้สิทธิ์เข้า Service อัตโนมัติ:** ผู้ใช้เดิมต้องได้รับสมาชิกและ Role จาก Admin ก่อนใช้ SSO กับ Service นั้น token เดิมของผู้ที่ยังไม่ได้รับสิทธิ์จะไม่ผ่านการตรวจหลังเปลี่ยนเวอร์ชัน (ภายในอายุ cache สูงสุด 5 วินาที)

Runtime ต้องมีสิทธิ์ SELECT/INSERT/UPDATE/DELETE ตามการทำงานของสามตารางใหม่ แต่ไม่มี DDL และยังห้าม UPDATE/DELETE `audit_logs` เช่นเดิม Schema และ migration ได้ทดสอบบน MariaDB ในเครื่อง; ไม่ได้รันกับ host จริง
