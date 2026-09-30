# อัปเดตรอบ Security / OTP — 2026-09-30

## ขั้นตอนบน Plesk ที่ติดตั้งระบบแล้ว

1. สำรอง DB และ secrets ที่ใช้ถอดรหัสไว้คนละพื้นที่ที่จำกัดสิทธิ์ เปิด maintenance ที่ reverse proxy ระหว่าง migration
2. อัปโหลด source, lockfile และ **server/migrations/** ครบ ห้ามแก้ไฟล์ migration 001–003 ที่เคยรันแล้ว
3. รัน `npm ci --include=dev` และ `npm run build`
4. ใช้บัญชี migration ที่มี ALTER/INDEX รัน **`npm run db:migrate`** จาก Application Root จะเพิ่ม migration `004_security_hardening.sql`, `005_mfa_reset_evidence.sql` และ `006_additional_factors.sql` แบบ additive ไม่ลบ user/audit เดิม ไม่ต้องเปิด `/install` ซ้ำ
5. เปลี่ยนกลับมาใช้ DB runtime account ที่จำกัดสิทธิ์ตาม `server/sql/runtime-grants.sql` และตั้ง `NODE_ENV=production`, HTTPS APP_ORIGIN, `INSTALL_ENABLED=false`, ล้าง `INSTALL_TOKEN`
6. Restart App แล้วตรวจ `/api/ready` ได้ 200 ผู้ดูแลที่ยังไม่มี TOTP ต้องเปิด Authenticator และเก็บ Recovery codes ก่อนเข้าเมนู Admin
7. ทดสอบ Google → Email OTP → Ref → resend → logout, TOTP/recovery, การเชื่อมต่อ Service, revoke และ Audit ด้วยบัญชี staging ก่อนเปิดผู้ใช้ทั้งหมด
8. สำหรับคำขอรีเซ็ต MFA ตั้ง `MFA_EVIDENCE_KEY` และ private `MFA_EVIDENCE_DIR`, ยกเว้นไฟล์หลักฐานและกุญแจจาก backup/snapshot, ตั้ง purge ทุก 15 นาทีตาม [คู่มือ MFA](MFA-RESET.md) ก่อนรับเอกสารจริง หากไม่พร้อมให้เว้นกุญแจว่างไว้เพื่อปิดการอัปโหลด

Plesk: Application Root คือโฟลเดนที่มี package.json, Document Root เป็นโฟลเดอร์ `public` ใต้ Application Root, Startup `app.cjs` ใช้ Node LTS ที่รองรับตามคู่มือ PLESK.md `.env` ต้องอยู่นอก Document Root และไม่อยู่ใน Git

Migration ต้องรันก่อนเริ่มโค้ดใหม่ หากต้องย้อนกลับ โค้ดเก่าอ่าน schema ที่เพิ่มคอลัมน์ได้ แต่ต้องคง migration 004–006 และ checksum ไว้ ห้ามลบคอลัมน์/ลบ journal เพื่อแก้ checksum ระหว่าง rollback

## นโยบาย OTP / Admin

- Email OTP 6 หลัก + Ref 8 ตัวอักษรจาก CSPRNG (Ref ไม่ใช่ secret) ยืนยันด้วย `{code,reference}` ชุดล่าสุดของเซสชันนั้นเท่านั้น Ref ในหน้าเว็บและอีเมลตรงกัน
- เว้นอย่างน้อย 60 วินาที **ต่อบัญชี** ผ่าน DB row lock รวมหลายแท็บ/หลาย instance/การล็อกอินใหม่ คง quota 3 requests ต่อ 10 นาทีต่อ IP/บัญชีด้วย การขอเกิน quota อาจต้องรอนานกว่า 60 วินาที
- Gmail ล้มเหลว: ยกเลิก challenge ที่ออกและคง cooldown ไว้ รหัสที่อาจส่งถึงหลัง timeout จะใช้ไม่ได้ ผู้ใช้ขอใหม่เมื่อครบเวลา UI อ่าน Retry-After และสถานะจาก `/auth/me` หลัง reload
- อีเมล multipart HTML/plain text ใช้ชื่อผู้ส่ง CUSA SSO ระบุวัตถุประสงค์เข้าสู่ระบบและชื่อ Service จากทะเบียนฝั่ง server ไม่รับชื่อ Service จาก body ของการส่ง OTP
- Admin API ต้องเป็น TOTP session; recovery/email session เปิดหน้า Security เพื่อ enroll ได้ การแก้สิทธิ์ต้องยืนยัน TOTP ภายใน 5 นาทีผ่าน `/api/auth/reauth` และตรวจ session ซ้ำใน transaction ของ mutation
- TOTP ที่ใช้แล้วใช้ซ้ำไม่ได้ แม้ใน reauthentication รอรหัสรอบถัดไปถ้าเพิ่งใช้รหัสเดียวกัน

## Proxy / IP บน HostAtom

โค้ดรองรับ TRUST_PROXY=false, loopback หรือรายการ IP/CIDR เช่น `127.0.0.1/32,::1/128` เก็บ client IP ที่ Express คำนวณจาก trust chain, peer IP ของ socket, แหล่ง IP และ request UUID ที่ server สร้างเอง ไม่เชื่อ X-Request-ID ที่ client ส่งมา

ให้ HostAtom ยืนยัน chain nginx/Apache/Passenger และการเขียนทับ/append X-Forwarded-For ก่อนเลือก trust list: หาก hop สุดท้ายอยู่ loopback และ proxy boundary จัดการ header ถูกต้องใช้ `TRUST_PROXY=loopback` ได้ ห้ามเปิด `true` หรือ trust IP สาธารณะทั้งหมด ค่า `1` คงไว้เพื่อ compatibility แต่ไม่แนะนำหากมีหลายเส้นทางจำนวน hop ต่างกัน

หลังตั้งค่า ส่งคำขอจากนอก Host พร้อม X-Forwarded-For ปลอม ตรวจว่า client IP ใน Audit ยังเป็น IP จริง; peer อาจเป็น 127.0.0.1 ตามปกติ ไม่สามารถย้อนหา IP จริงจาก log เก่าที่บันทึกเพียง loopback ได้ จึงไม่แก้ audit เก่าย้อนหลัง

## Rate limit / Introspection

- `/health` และ `/ready` ไม่ใช้ quota ของ login; browser API มี local coarse limit 180/min/IP
- `/sso/token` และ `/sso/introspect` มี coarse limit 12,000/min/IP แล้วตรวจ API key/scopes จาก DB ก่อนโควตาร่วมทุก instance: 3,000/min/application และ 1,500/min/key ทั้งสอง endpoint รวมกัน
- โควตาใช้ ID ของ application/key ที่ตรวจแล้ว ไม่ใช้ raw API key หรือ header ที่ยังไม่ authenticate ใช้ Redis เมื่อกำหนดไว้ หรือ MariaDB เมื่อไม่ได้ตั้ง Redis; หาก Redis ที่ตั้งไว้ล่ม ให้ปฏิเสธคำขอ ไม่สลับ storage จนโควตาเริ่มใหม่
- Introspection โหลด identity ด้วย SELECT เดียว ไม่มี FOR UPDATE และไม่ UPDATE last_used_at ในเส้นทางนี้; ฟิลด์ lastUsedAt จึงสะท้อนการแลก token ไม่ใช่ทุก introspection
- Cache identity สูงสุด 5 วินาทีและไม่เกิน credential expiry มี single-flight บัญชี/role/session revoke อาจสะท้อนช้าสูงสุด TTL; API key ตรวจสิทธิ์ทุก request ก่อน cache
- BFF ไม่ควรเพิ่ม positive cache อีกชั้นถ้าต้องการขอบเขต revoke สูงสุด 5 วินาที การ cache ซ้อนอาจบวก latency ของ revoke

## Audit / Operations

- Audit เพิ่ม request ID, peer IP, IP source, actor type, application/key IDs, redaction และ before/after ของ profile/role/membership; failed MFA counter+audit อยู่ใน transaction เดียวกัน
- Admin อ่าน audit มี `audit.search`; CLI export เขียน `audit.export.started/completed` ลง stderr ให้ระบบรวบรวม log แยก เพราะบัญชี archive ควรเป็น read-only
- Failure storms ของ rate limiting/installer/HTTP เขียน structured log แบบรวมจำนวน ไม่เก็บ secret/header/raw error ลง stderr การเก็บ stderr ระยะยาวต้องตั้งที่ Host
- Audit list ใช้ keyset `(created_at,id)` ไม่มี COUNT/OFFSET ค่าเริ่มต้น 7 วัน ขอบเขตครั้งละ 31 วัน ส่ง `meta.nextCursor` กลับใน `cursor` ของหน้าถัดไป total ไม่ใช่จำนวนทั้งหมดอีกต่อไป
- Production API ปิดรับเมื่อ worker faulted หรือ backlog ≥10,000 หรือ event เก่าสุด ≥300 วินาที ตรวจ queue ทุก 5 วินาทีแบบ single-flight; health/ready/หน้าเว็บยังเปิดให้ตรวจอาการ
- ตั้ง external monitor `/api/ready` ทุก 30 วินาที, alert เมื่อ 503 สองรอบ, alert CRITICAL ของ worker ทันที และตรวจ disk <20%, backlog >30 วินาทีต่อเนื่อง ปรับ threshold ตาม load จริงก่อนใช้
- ตั้ง Scheduled Task `npm run ops:check -w server` จาก Application Root ทุก 1–5 นาที เก็บ JSON output และ alert เมื่อ exit code ไม่ใช่ 0 ตรวจ UTC, backlog และ broad/protected-table grants โดยไม่พิมพ์ raw SHOW GRANTS
- Reader/retention account, archive storage ที่แยกสิทธิ์, backup restore drill และการส่ง alert จริงต้องตั้งโดยผู้ดูแล Host ดู AUDIT-OPERATIONS.md การเขียนคู่มือไม่ได้หมายความว่าตั้งงานเหล่านี้บน Host แล้ว

## ขอบเขตที่ยังต้องยืนยันบนสภาพแวดล้อมจริง

การทดสอบในเครื่องไม่ยืนยัน DNS ownership, proxy sanitization, สิทธิ์ MariaDB บน Host, Gmail delivery/inbox rendering หรือ throughput เป้าหมาย ให้ใช้ staging credentials และ load test ที่ได้รับอนุญาตก่อนเปิด production ไม่มีการส่ง OTP จริง เปลี่ยน DNS หรือรัน migration บน Host จากรอบพัฒนานี้

งานเสริมจาก Audit ที่แยกเป็นเฟสถัดไป: idle session policy, WebAuthn, keyring สำหรับหมุน AES keys, remote immutable archive/KMS signing และ retention ตามนโยบายองค์กร ปัจจุบันยังใช้ absolute session expiry/concurrent limit และ AES-GCM key เดียว ห้ามเปลี่ยน ENCRYPTION_KEY ทับโดยไม่มีแผน re-encrypt และเก็บกุญแจเก่าเพื่อ restore

MFA reset ใช้ master key แยกพร้อมกุญแจสุ่มรายเอกสาร แต่ยังไม่มีเครื่องมือหมุน master key ระหว่างมีเอกสารค้าง ห้ามเปลี่ยน `MFA_EVIDENCE_KEY` ทับ หลักฐานมีข้อมูลส่วนบุคคลที่ละเอียดอ่อนต่อความเสี่ยง ให้ผู้รับผิดชอบข้อมูลตรวจนโยบาย การปิดข้อมูลในภาพ และการสำรองก่อนเปิดใช้งาน

## Migration 006 และการเพิ่มช่องทางยืนยัน

ให้รัน 006 ก่อนเปิดโค้ดใหม่ เพิ่ม runtime SELECT/INSERT/UPDATE/DELETE เฉพาะ passkeys, line_identities, phone_identities, factor_challenges และคง audit_logs append-only ตามเดิม ตั้งค่า provider ตาม [ADDITIONAL-FACTORS.md](ADDITIONAL-FACTORS.md); ทดสอบบน staging HTTPS ก่อนเปิด flags ใน production การย้อนโค้ดไม่ควรลบ migration history หรือลบ factor bindings ที่ผู้ใช้สร้างแล้วโดยไม่มีแผนกู้คืน
