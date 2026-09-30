# CUSA SSO — รายงานตรวจโค้ดและข้อเสนอปรับปรุง

วันที่ 30 กันยายน 2569 · Source revision `6a5e6c7`

ขอบเขต: โค้ด Express/React, migrations, ตัวติดตั้ง, เส้นทาง SSO/MFA/Admin, Audit Outbox และเอกสารปฏิบัติการใน workspace ประกอบกับภาพ Plesk/phpMyAdmin ที่ผู้ใช้ส่งมา ตรวจ source และรันการจำลองใน localhost เท่านั้น ไม่ได้เข้าถึง production DB, ตรวจ proxy configuration จริง หรือทำ penetration/load test บน HostAtom รายงานนี้ไม่ใช่การรับรองความปลอดภัยหรือ compliance

คำว่า P1 หมายถึงควรจัดการก่อนขยายการใช้งานจริง; P2 หมายถึงควรจัดลำดับพัฒนารอบถัดไป ไม่ใช่คะแนน CVSS จุดที่ต้องยืนยันบน Host ระบุแยกจากข้อค้นพบในโค้ด ไม่ได้แก้โค้ดหรือ Environment ระหว่างการตรวจครั้งนี้

## 1. P1 — IP ที่ใช้ใน Audit และ Rate Limit ยังต้องยืนยันเส้นทางจริง

**หลักฐาน:** ภาพ Audit แสดง `127.0.0.1` หลายเหตุการณ์; `.env` ใน workspace ยังเป็น `TRUST_PROXY=false` แต่ไม่อาจอนุมานว่า Environment ของ process บน Host ตรงกัน โค้ดใช้ `req.ip` ทั้งบันทึก Audit และสร้าง rate-limit bucket ที่ [security.ts](../server/src/middleware/security.ts:44) และ [security.ts](../server/src/middleware/security.ts:60); รูปแบบ config อยู่ที่ [config.ts](../server/src/config.ts:26)

**ผลกระทบ:** หาก proxy ทำให้ผู้ใช้ทุกคนมี IP เดียวกัน จะสืบย้อนต้นทางไม่ได้ และผู้ใช้/ระบบลูกแชร์โควตา IP เดียวกัน การเปิด trust โดยไม่ตรวจ proxy อาจทำให้ header ที่ผู้ใช้ปลอมถูกเชื่อถือ

**แก้ที่:** `config.ts`, middleware สำหรับ request context และ Nginx/Apache/Passenger บน Host ใช้ `loopback` ได้เมื่อ proxy ที่ส่งถึง Node อยู่ loopback และจัดการ forwarded headers ถูกต้อง หาก topology ต่างออกไปให้รองรับรายการ IP/CIDR ที่ระบุชัดเจน ปิดการเข้าถึง backend port โดยตรงตามสภาพแวดล้อม

**เพิ่ม:** แยก `client_ip`, `peer_ip`, `ip_source` และ `request_id` โดยคงคอลัมน์เดิมให้ย้อนหลังเข้ากันได้ ใช้ client IP ที่ตรวจสอบแล้วใน rate limiter เช่นเดียวกับ Audit; ตรวจ/normalize IPv4/IPv6 และกำหนดนโยบายจัดกลุ่ม IPv6 สำหรับโควตา โดยไม่เปลี่ยน IP จริงที่เก็บเป็นหลักฐาน

**เกณฑ์รับงาน:** เครื่องทดสอบคนละเครือข่ายให้ผลตรงกับ access log ของ trusted edge; ปลอม X-Forwarded-For แล้วเปลี่ยนตัวตน/หลบโควตาไม่ได้; direct request ที่ไม่ได้มาจาก trusted proxy ต้องไม่เชื่อ header ไม่แก้ IP ในแถวเก่าด้วยการเดา

การจำลองในเครื่องยืนยันว่า trust=false ให้ loopback, loopback trust เลือก first untrusted address จากด้านใกล้แอป และ direct public peer ไม่สามารถเปลี่ยน IP ด้วย header ได้เมื่อ config ตรงเงื่อนไข อ้างอิง [Express behind proxies](https://expressjs.com/en/guide/behind-proxies/)

## 2. P1 — Rate Limit รวมครอบและลดโควตา SSO ที่ตั้งไว้

**หลักฐาน:** [app.ts](../server/src/app.ts:24) จำกัดทุก `/api` ที่ 180 requests/minute/IP/process ก่อน routing รวมทั้ง health checks ส่วน [ssoRoutes.ts](../server/src/routes/ssoRoutes.ts:12) ตั้ง introspection ไว้ 300/minute และ [security.ts](../server/src/middleware/security.ts:44) ใช้ IP เป็น bucket หลัก; machine requests ปกติไม่มี user session จึงไม่แบ่งตามผู้ใช้หรือ Service

**ทำซ้ำแล้ว:** ส่ง health request 180 ครั้งจาก localhost เดียวกัน แล้ว POST introspection ได้ 429 จากตัวจำกัดรวม ก่อนถึง authentication/ตัวจำกัดเฉพาะ endpoint การจำลองนี้ไม่เรียก DB หรือใช้ API key จริง

**ผลกระทบ:** BFF หลายตัวที่ออกผ่าน IP เดียวกันแชร์โควตา; โควตา introspection 300 ใช้ไม่ถึงตามที่ตั้งไว้; polling health ใช้โควตาร่วมด้วย การเพิ่ม cache ไม่ช่วยส่วนที่ถูกปฏิเสธก่อนถึง controller

**แก้ที่:** `app.ts`, `ssoRoutes.ts`, `security.ts`, `rateLimitStore.ts` แยก login/browser, machine API และ monitoring ให้ชัดเจน คง coarse IP protection สำหรับคำขอที่ยังไม่ยืนยัน แล้วเพิ่ม shared quota ตาม application/API-key ID ที่ตรวจสอบสำเร็จแล้ว ห้ามใช้ raw key เป็นชื่อ bucket หรือเชื่อ client ID ที่ยังไม่ผ่าน authentication

**เกณฑ์รับงาน:** Service A ใช้โควตาหมดแล้ว Service B ยังทำงานได้ตาม policy แม้มี egress IP เดียวกัน; health checks ไม่แย่งโควตา authentication; ตัวนับจำกัดได้ตรงกันหลาย process; ทดสอบ IPv6 และโหลดที่กำหนดจริง

## 3. P1 — Admin ยังไม่มีข้อบังคับ MFA ที่เป็นอิสระและการยืนยันใหม่ก่อนงานสำคัญ

**หลักฐาน:** [security.ts](../server/src/middleware/security.ts:27) ตรวจเพียง full session และ role=admin; [adminRoutes.ts](../server/src/routes/adminRoutes.ts:8) ใช้ guard นี้กับทุก admin operation ไม่ตรวจ `mfaMethod` หรืออายุ `authenticatedAt` อายุ session ค่าเริ่มต้น 8 ชั่วโมงที่ [config.ts](../server/src/config.ts:24)

**ทำซ้ำแล้ว:** ส่ง identity จำลอง role=admin, kind=full, mfaMethod=email, authenticatedAt เมื่อ 7 ชั่วโมงก่อนให้ guard และผ่านได้ เป็นการทดสอบ guard ในเครื่อง ไม่ใช่การแอบอ้าง session ของผู้ใช้จริง

**ผลกระทบ:** Google Login ตามด้วย OTP ที่ส่งเข้าบัญชี Google/Gmail เดียวกันยังพึ่งบัญชีเดียว หากบัญชีนั้นถูกยึด ผู้โจมตีอาจผ่านทั้งสองขั้นได้ การได้ full admin session ก็ไม่ต้องยืนยันใหม่ก่อนเพิ่ม admin/เปลี่ยนสิทธิ์/สร้าง API key ข้อนี้เป็นช่องว่างของนโยบายความปลอดภัยสำหรับงานสิทธิ์สูง ไม่ใช่หลักฐานว่าข้าม Google Login ได้

**แก้ที่:** `security.ts`, `adminRoutes.ts`, auth controllers/models และหน้า Security เพิ่ม policy บังคับ Admin ลงทะเบียน TOTP หรือ WebAuthn/Passkey และ middleware `requireRecentMfa` สำหรับงานสำคัญ เช่น ต้องยืนยันไม่เกิน 5 นาทีซึ่งเป็นค่าที่องค์กรเลือกได้ พร้อม endpoint ยืนยันซ้ำและหน้าจอที่รองรับ

ให้มีขั้นตอนสำหรับ admin คนแรกและบัญชีที่ใช้ recovery code เพื่อกลับมาตั้งค่า factor ได้ โดยยังเข้าเมนูตั้งค่าความปลอดภัยได้ ไม่ล็อกผู้ดูแลทุกคนออกจากระบบ เพิ่มการแจ้งเจ้าของบัญชีเมื่อเปลี่ยน MFA/สิทธิ์สำคัญ

**เกณฑ์รับงาน:** email-only/stale admin session ทำรายการสำคัญไม่ได้; fresh factor ผ่านได้; recovery และ first-admin enrollment ทำงาน; ทดสอบ session ที่ถูก revoke ระหว่างยืนยัน และการป้องกันใช้ TOTP ซ้ำ อ้างอิง [OWASP MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)

## 4. P2 — Introspection ใช้ row locks และเขียน API-key row ทุก cache miss

**หลักฐาน:** [ssoModel.ts](../server/src/models/ssoModel.ts:74) ใช้ `FOR UPDATE` ตรวจ key/application; [ssoModel.ts](../server/src/models/ssoModel.ts:167) ทำ introspection ใน transaction, ใช้ `FOR UPDATE` กับ token joins และ update `last_used_at` ทุกครั้ง

**ผลกระทบ:** คำขอของผู้ใช้ต่างคนที่ใช้ API key เดียวกันต้องแย่ง lock เดียวกัน และอาจชนกับ key/application อื่นที่ใช้แถวร่วมกัน Cache ช่วย token ที่เคยอ่าน แต่ไม่กำจัดการรอเมื่อมี token ต่างกันจำนวนมาก ยังไม่ได้วัด latency/throughput บน Host จึงไม่ระบุเปอร์เซ็นต์การปรับปรุง

**แก้ที่:** แยก read-only validation query สำหรับ introspection ซึ่งตรวจ key/application/token/session/membership/roles ใน snapshot ที่สอดคล้องกัน ย้ายหรือจำกัดความถี่การเขียน last_used_at คง transaction/lock สำหรับการ consume authorization code ครั้งเดียว การ revoke และการเปลี่ยนสิทธิ์ ห้ามเอา locks ออกจากทุก endpoint เหมารวม

**เกณฑ์รับงาน:** ทดสอบ distinct tokens ภายใต้ key เดียวหลายคำขอพร้อมกันพร้อมวัด lock waits; key/role/session revoke ยังมีผลตามสัญญา cache สูงสุด 5 วินาที และไม่มี cache ที่อยู่เลย credential expiry

## 5. P2 — Audit ขาด context และเหตุผลในเส้นทางสำคัญ

**หลักฐาน:**

- [authController.ts](../server/src/controllers/authController.ts:54) รวมความล้มเหลว Google ทุกชนิดเป็น event เดียวโดยไม่มี reason และละทิ้ง error เมื่อบันทึก failure ไม่สำเร็จ
- [adminModel.ts](../server/src/models/adminModel.ts:249) bootstrap บันทึกเฉพาะ id/event/target/metadata แม้ source=web_install จึงไม่มี IP/User-Agent การ insert นี้ยังอยู่ใน transaction เดียวกับ admin และ marker; ไม่ใช่ปัญหา atomicity
- [app.ts](../server/src/app.ts:53) มี generic failure บางกรณี แต่ไม่มี request_id ใช้เชื่อมเหตุการณ์; local 429 ใน `app.ts` และข้อผิดพลาด installer ที่ [installRoutes.ts](../server/src/routes/installRoutes.ts:38) ตอบเองโดยไม่ผ่าน Audit กลาง
- [serviceAccessModel.ts](../server/src/models/serviceAccessModel.ts:89) เก็บ Role ชุดใหม่โดยไม่มีชุดเดิม ส่วน [adminModel.ts](../server/src/models/adminModel.ts:93) เก็บเพียงชื่อ fields ของ profile ที่เปลี่ยน
- [adminController.ts](../server/src/controllers/adminController.ts:16) อ่าน Audit โดยไม่มี event ระบุผู้เปิดดู

**แก้ที่:** สร้าง request context middleware กลาง ส่ง context เดียวกันไป controller/model/outbox เพิ่ม controlled failure reason เช่น STATE_INVALID, GOOGLE_EXCHANGE_FAILED, EMAIL_NOT_ALLOWED โดยไม่บันทึก raw provider response, authorization code, cookie, OTP หรือ token

สำหรับ installer ให้ส่ง trusted request IP/User-Agent/request_id ไปยัง bootstrap และใช้ actor_type=installer; สำหรับ CLI ใช้ actor_type=system/source=cli และปล่อย IP เป็น NULL ได้ ไม่อ้างว่า admin เป้าหมายเป็นผู้กระทำก่อนยืนยันตัวตน

เพิ่ม event สำหรับ read/export logs และ before/after เฉพาะข้อมูลสิทธิ์ที่จำเป็น ใช้ allowlist/redaction ของ metadata บันทึก failed MFA และการเปลี่ยนตัวนับ/lockout ใน transaction เดียวกันเมื่อเป็นไปได้ แยก event สาเหตุหลักกับ HTTP outcome ให้สัมพันธ์กันเพื่อไม่นับเหตุเดียวเป็นหลาย incident

Rate-limit failures ควรส่งเป็น event/metric ที่ควบคุมปริมาณได้ ไม่ทำให้ทุกคำขอโจมตีกลายเป็น insert DB เพิ่ม ก่อนมี schema ให้ installer failure ไป structured process log ที่ host เก็บได้

**เกณฑ์รับงาน:** ไล่เหตุการณ์หนึ่งคำขอได้จาก request_id, แยกสาเหตุ login fail ได้, bootstrap ทางเว็บมี context, CLI ไม่สร้าง IP ปลอม, role diff ย้อนอ่านได้, และไม่มี secret ใน log อ้างอิง [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

## 6. P2 — Worker หยุดได้ แต่การแจ้งเตือน/การรับ traffic ขึ้นกับ Host

**หลักฐาน:** [auditWorker.ts](../server/src/services/auditWorker.ts:46) หยุดหลังผิดพลาดสามครั้งและเขียน stderr; [app.ts](../server/src/app.ts:29) รายงาน readiness 503 แต่ไม่ได้ใช้ readiness เป็น middleware ปิด traffic; [index.ts](../server/src/index.ts:6) รัน worker อยู่ใน process เว็บ เอกสารกำหนด external monitoring ไว้ แต่ยังไม่ได้ยืนยันว่าติดตั้งบน Host จริง

**ผลกระทบ:** เมื่อ worker หยุด API ยัง enqueue ลง outbox ได้ต่อไป ข้อมูลยัง durable แต่ยังไม่ปรากฏใน audit_logs และ backlog อาจโตจนกระทบ disk การมี `/api/ready` อย่างเดียวไม่ได้ทำให้ Plesk ถอน traffic หรือส่ง on-call alert โดยอัตโนมัติ

**แก้ที่:** ตั้ง external monitoring สำหรับ readiness, backlog age/count, disk, worker fault และเวลาประมวลผลล่าสุด กำหนดผู้รับแจ้งเตือนและ runbook จริง ตรวจ lifecycle ของ Passenger และแยก worker service หาก Host รองรับ กำหนด threshold สำหรับ backpressure และงานใดต้องหยุดเมื่อเก็บหลักฐานต่อไม่ได้

**เกณฑ์รับงาน:** จำลอง worker fault ใน environment ทดสอบแล้วผู้ดูแลได้รับ alert ภายในเวลาที่กำหนด; outbox ไม่สูญข้อมูล; repair/replay/restart กลับมาทำงานได้ โดยไม่ใช้ INSERT IGNORE หรือทิ้ง poison event

## 7. P2 — การค้น Audit บนหน้า Admin ยังแพงเมื่อข้อมูลโต

**หลักฐาน:** [adminModel.ts](../server/src/models/adminModel.ts:35) ทำ COUNT และ OFFSET; [adminModel.ts](../server/src/models/adminModel.ts:111) ใช้ substring LIKE หลายคอลัมน์โดยไม่บังคับช่วงเวลา; [adminValidation.ts](../server/src/controllers/adminValidation.ts:9) อนุญาต page ถึง 1,000,000 ส่วน exporter ใช้ keyset อยู่แล้ว จึงไม่ต้องเขียน exporter ใหม่

**ผลกระทบ:** หน้าไกล ๆ และการค้นทุกช่วงเวลามีโอกาสอ่านข้อมูลจำนวนมากแม้มี indexes ต้องวัดกับข้อมูลจำลองตามขนาดจริง ยังไม่มีผล EXPLAIN/โหลด production ในการตรวจนี้

**แก้ที่:** controller/model/Admin UI ของ Audit ใช้ cursor `(created_at,id)` และช่วงเวลาเริ่มต้น เช่น 7 วัน จำกัดช่วงสูงสุดและแยก full export เป็นงานเฉพาะ ลด COUNT ทุก request หรือให้ total เป็นข้อมูลเสริม ใช้ composite indexes ที่มีอยู่กับ filter ให้เหมาะสมก่อนเพิ่ม index ใหม่

**เกณฑ์รับงาน:** EXPLAIN และทดสอบข้อมูลระดับเป้าหมาย; cursor ไม่ซ้ำ/ตกหล่นใน snapshot ที่กำหนด; endpoint ใช้เวลา/ทรัพยากรอยู่ใน budget ที่ทีมกำหนด

## 8. P1 หากยังใช้สิทธิ์ติดตั้ง — ต้องยืนยัน append-only ที่ DB จริง

**หลักฐาน:** โค้ด runtime ไม่ UPDATE/DELETE audit_logs และ [AUDIT-OPERATIONS.md](AUDIT-OPERATIONS.md:11) ระบุการแยกบัญชีไว้ แต่ไม่ได้มีหลักฐาน SHOW GRANTS ของ runtime บน Host ภาพ phpMyAdmin ที่มี Edit/Delete บอกได้เพียงว่า UI แสดงเครื่องมือเหล่านี้ ไม่ใช่หลักฐานว่าบัญชี runtime มีสิทธิ์เดียวกัน

**ความเสี่ยงตามเงื่อนไข:** หากหลัง `/install` ยังใช้ account ที่มีสิทธิ์ DDL/แก้ไข audit_logs ผู้ที่ยึด process/credential ได้อาจแก้หรือลบหลักฐานได้ การเพิ่ม GRANT รายตารางไม่หักล้างสิทธิ์กว้างที่ให้ไว้ระดับ schema

**ตรวจและแก้ที่:** สิทธิ์ DB/Plesk, runtime environment และคู่มือ handoff หลังติดตั้ง ให้ผู้ดูแลตรวจ `SHOW GRANTS FOR CURRENT_USER()` ด้วยบัญชีที่แอปใช้จริง แยก installer/migration, runtime, audit reader และ retention operator; runtime ต้องไม่มี UPDATE/DELETE/ALTER/DROP บน audit_logs และไม่ควรมีสิทธิ์แก้ marker ติดตั้ง

เพิ่มการส่ง archive ไป storage ที่แยกสิทธิ์และแก้ไขย้อนหลังไม่ได้ตามข้อกำหนดองค์กร พร้อม checksum/restore check การมี hash chain ใน DB เดียวกันเพียงอย่างเดียวไม่ป้องกันผู้ที่เขียนใหม่ได้ทั้งสาย จึงไม่ใช่ข้อแรกที่ควรทำ

**เกณฑ์รับงาน:** ตรวจ grants และทดสอบสิทธิ์ด้วยบัญชีจำลองใน staging; runtime เขียน/อ่าน audit ตามจำเป็นได้แต่แก้/ลบไม่ได้; แยก credential และทดสอบ restore จากสำเนานอกเครื่อง การทดสอบนี้ยังไม่ได้ทำบน Host

## งานเสริมที่ควรวางต่อ

- Session: เพิ่ม last_seen_at/idle timeout และ device/IP ล่าสุดแบบจำกัดความถี่การเขียน เพื่อช่วยผู้ใช้ดูและ revoke อุปกรณ์ ปัจจุบันมี absolute expiry และจำกัด session อยู่แล้ว อย่าบังคับ logout ทุกครั้งที่ IP มือถือเปลี่ยน ให้ใช้ความเสี่ยงประกอบ
- Secrets: เพิ่ม key version/keyring สำหรับ AES-GCM และคู่มือหมุน ENCRYPTION_KEY พร้อม migrate ข้อมูล ทดสอบ restore DB พร้อมกุญแจแยกที่เก็บ หากเปลี่ยน key เดียวปัจจุบันทับจะอ่าน TOTP secret เดิมไม่ได้
- Retention: กำหนดระยะเวลาและผู้รับผิดชอบแยกสำหรับ user ที่ soft-delete, audit, archive, backup และ legal hold; ตั้ง cleanup/archive schedule จริงตามคู่มือ ไม่กำหนด 90 วันให้ข้อมูลทุกประเภทโดยไม่มีนโยบายองค์กร
- Deployment: ยืนยัน Node LTS, Document Root=public, `.env` อยู่นอก public, INSTALL_ENABLED=false/token cleared, Google callback ตรง production origin และ proxy chain จริง ภาพเก่าไม่ยืนยันว่าค่าเหล่านี้ยังผิดอยู่ในปัจจุบัน
- Transport: ไม่ต้องเปลี่ยน DB localhost กลับเป็น public IP เพื่อใช้ TLS ตรวจว่า localhost เป็นเส้นทางบน host เดียวกันจริง; public DB endpoint ยังคงต้อง verified TLS ตาม config เดิม

## สิ่งที่ควรรักษาไว้

ตรวจพบการใช้ PKCE S256, OAuth state/nonce ผูก browser, exact registered callback, secure HttpOnly cookies ตาม HTTPS origin, CSRF protection, recovery code ใช้ครั้งเดียว, AES-GCM สำหรับ TOTP, parameterized queries, transactional outbox และ Role ที่ผูก application พร้อม default deny

HMAC-SHA-256 สำหรับ token/API key ที่สุ่ม entropy สูงและต้อง lookup ด้วย index เหมาะกับงานนี้ ไม่จำเป็นต้องเปลี่ยนทุกอย่างเป็น Argon2id; OTP ที่เดาง่ายมี Argon2id อยู่แล้ว ระบบใช้ UUID อ้างอิง session ภายในใน Audit ซึ่งไม่ใช่ค่า bearer cookie จริง ทั้งนี้ test ผ่านไม่ได้ยืนยันว่าปลอดภัยจากช่องโหว่ทุกชนิด

## การตรวจที่ทำในรอบนี้

- `npm run typecheck`: server และ web ผ่าน
- ชุดทดสอบเฉพาะ crypto, proxy transport, audit, cache, SSO model/HTTP, validation และ install HTTP: 51 ผ่าน, 0 ล้มเหลว, 0 ข้าม; ใช้ `--test-concurrency=1`, synthetic/disabled credentials และไม่ต่อ DB จริง
- การจำลองเพิ่มเติม 3 ประเด็น: proxy trust boundaries, email/stale admin guard, rate-limit รวม 180 → introspection 429; ผลตรงกับข้อค้นพบ
- ไม่ได้รัน MariaDB integration, production load, dependency advisory scan, ตรวจ TLS/GRANT/monitoring ของ Host หรือทดสอบ Google/Gmail สดในรอบนี้

ลำดับทำงานที่เสนอ: ยืนยัน IP/DB grants บน Host → แก้ Rate Limit → เพิ่ม Admin MFA/step-up → เติม Audit context/reasons → ตั้ง monitoring/backup → ปรับ introspection และ Audit search จากผลวัดจริง


## ผลการแก้ไขตามรายงาน — 30 กันยายน 2569

ข้อความด้านบนเป็นข้อค้นพบก่อนแก้ไข ไม่ใช่สถานะปัจจุบันของทุกไฟล์ การแก้ไขรอบนี้ครอบคลุม:

| ประเด็น | ผลในโค้ด / เงื่อนไขภายนอก |
| --- | --- |
| IP / proxy | เพิ่ม client/peer/source/request ID, CIDR trust validation และ spoof tests; ต้องยืนยัน header chain บน HostAtom |
| โควตา machine API | แยกจาก browser, ตรวจ key/scope ก่อน quota ตาม Application/key และก่อน cache |
| สิทธิ์ Admin | บังคับ TOTP, enrollment gate, fresh MFA ภายใน 5 นาทีสำหรับ writes และ private evidence |
| introspection performance | SELECT identity เดียว, ไม่มี row-lock/write last_used_at; คง cache/expiry/audience isolation |
| Audit evidence | บันทึก failed MFA ใน transaction, redaction, before/after, search/export evidence และ actor context |
| Operations | fail-closed เมื่อ worker/backlog ผิดปกติ, read-only ops check; ต้องตั้ง alert/scheduler บน Host |
| Pagination | audit keyset/time bound ไม่มี COUNT/OFFSET; MFA recovery queue ใช้ keyset ด้วย |
| DB privileges | เพิ่ม runtime-grants.sql และทดสอบบัญชีจำลองว่า INSERT audit ได้แต่ UPDATE/DELETE ไม่ได้; ยังไม่เปลี่ยน grants บน Host |

เพิ่ม OTP 6 ช่อง/Ref/cooldown 60 วินาที, email CUSA SSO พร้อมวัตถุประสงค์, public homepage/branding assets, API reference/OpenAPI/BFF และกระบวนการขอรีเซ็ต MFA พร้อม encrypted evidence ตาม [คู่มืออัปเกรด](SECURITY-UPGRADE.md) และ [คู่มือ MFA](MFA-RESET.md)

ดู [บันทึกทดสอบ](VALIDATION.md) สำหรับจำนวนและขอบเขตจริง การทดสอบในเครื่องไม่แทนการตรวจ penetration/load, ประเมินฐานกฎหมายของเอกสาร, Google branding approval, backup exclusions หรือการตรวจ host/proxy/DB grants จริง งาน WebAuthn, key rotation tooling, idle session, external immutable archive ยังคงเป็นงานเพิ่มเติมตามลำดับความเสี่ยง ไม่ใช่ฟีเจอร์ที่รอบนี้ได้ติดตั้งแล้ว

## ส่วนขยายหลังการแก้ไขชุดแรก

WebAuthn/Passkeys ที่กล่าวว่ายังเป็นงานเพิ่มเติมในบันทึกก่อนหน้า ได้เพิ่มเป็น MFA หลัง Google แล้วใน migration 006 พร้อม LINE Number Matching, Firebase ยืนยันเบอร์ครั้งแรก, Admin revoke sessions, private metrics และ deployment checks ดู [ผลทบทวน Blueprint](DELTA-REVIEW.md) ซึ่งแยกสิ่งที่ทำจริงจาก JWT/OIDC/SLO/public-registration/Secret Manager/off-site backup ที่ยังไม่เปิดใช้งาน ผลการตรวจล่าสุดอยู่ที่ [VALIDATION.md](VALIDATION.md)

พบ dependency uuid ทางอ้อมและเปลี่ยนเป็นรุ่นแก้ไข 11.1.1 ผ่าน override เฉพาะ gaxios 6; ตรวจ runtime advisory ซ้ำแล้วไม่พบรายการที่รายงาน การตรวจนี้ไม่แทน penetration test และยังต้องทดสอบ provider จริง/สิทธิ์ runtime/ข้อจำกัดของ HostAtom
