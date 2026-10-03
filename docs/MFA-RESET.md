# ขอเปลี่ยน Authenticator พร้อมหลักฐาน

ฟีเจอร์นี้ใช้เมื่อเจ้าของบัญชีไม่มีเครื่องเดิมและไม่มี Recovery code เจ้าของต้องผ่าน Google Login ด้วยบัญชีที่ยังอยู่ใน allowlist ก่อนส่งคำขอจากหน้า MFA ผู้ดูแลส่งคำขอแทนหรือระบุ user_id ของคนอื่นไม่ได้

## ก่อนเปิดใช้บน HostAtom / Plesk

1. รัน migration `005_mfa_reset_evidence.sql` ด้วยบัญชี migration แล้วสลับกลับบัญชี runtime ตาม [grants](../server/sql/runtime-grants.sql)
2. ตั้ง `MFA_EVIDENCE_KEY` เป็นกุญแจสุ่ม 32 bytes แบบ base64 **แยกจาก ENCRYPTION_KEY** เก็บเฉพาะ server `.env`/secret store ไม่ใส่ `VITE_*` หรือ Git `.env` ในเครื่องพัฒนาได้เพิ่มกุญแจใหม่ไว้แล้ว ต้องนำไปตั้งใน Host อย่างปลอดภัย ไม่ใช่คัดลอกจาก `.env.example`
3. ตั้ง `MFA_EVIDENCE_DIR` เป็น absolute path ของโฟลเดอร์ส่วนตัวที่ Node เขียนได้ เช่น `<APPLICATION_ROOT>/var/mfa-evidence` ค่า relative อ้างจาก Application Root ห้ามอยู่ใต้ Document Root, public, web/public, web/dist หรือ server/dist
4. Directory ใช้ 0700 และไฟล์ 0600 ต้องเป็น local/private filesystem ที่รองรับ atomic exclusive create และ no-follow symlink การรันหลาย instance ต้องเห็น directory เดียวกันและใช้กุญแจเดียวกัน หรือออกแบบ private object storage adapter ก่อน scale
5. **ไม่สำรอง directory นี้ รวมทั้ง `.enc` และ `.key`** ออกจาก Plesk backup และ Host/VM snapshots ด้วย ให้ HostAtom ยืนยันขอบเขต snapshot หาก provider เก็บทั้งไฟล์และกุญแจไว้ ระบบแอปเพียงอย่างเดียวไม่สามารถรับรองการทำลายทุกสำเนาภายใน 7 วันได้ ต้องแก้ขอบเขต backup ก่อนเปิดรับภาพจริง
6. ตั้ง `BACKGROUND_JOBS_ENABLED=true` แล้ว Restart App: Node จะลบหลักฐานเมื่อเริ่มแอปและทุก 15 นาที ใช้ `GET_LOCK` กันงานซ้อนกับ process อื่นและ CLI ไม่ต้องใช้ Plesk Cron ในโหมดนี้ ดู [คู่มือ HostAtom](HOSTATOM-RELEASE.md)
7. Node ตรวจสุขภาพระบบและเอกสารเกินกำหนดทุก 5 นาทีด้วย ติดตาม `background.job.failed` ใน stderr หรือ metrics ของแต่ละ process และตั้ง alert ผ่านระบบที่ Host รองรับ การเปิดงานภายในไม่ได้ส่งอีเมลแจ้งเตือนโดยอัตโนมัติ หากต้องรันภายนอกใช้ `node server/dist/scripts/operationsCheck.js` ได้
8. ทดสอบด้วยภาพจำลองก่อนรับเอกสารจริง: ส่ง → เปิดตรวจ → อนุมัติ/ปฏิเสธ → ตรวจการเพิกถอน → ทดสอบ purge ใน staging โดยปรับ deadline เฉพาะข้อมูลจำลอง

ขั้นตอนเลือกเมนูและตั้ง Cron บน HostAtom อยู่ใน [คู่มือ release](HOSTATOM-RELEASE.md) ตรวจ `Run Now` ด้วย เนื่องจาก task อาจเห็น Node path และ environment ต่างจาก web process

กุญแจว่างทำให้ปิดรับการอัปโหลด แต่ไม่หยุดการลบเอกสาร อย่าเปลี่ยน `MFA_EVIDENCE_KEY` ทับระหว่างมีเอกสารค้าง เพราะจะเปิดอ่านไม่ได้ ต้องจัดแผน rewrap กุญแจแยกต่างหากก่อนหมุนคีย์ แอปยังไม่มีหน้า key rotation

## ขั้นตอนและเงื่อนไข

- แนะนำ Recovery code ก่อนเพื่อหลีกเลี่ยงการเก็บเอกสารที่ไม่จำเป็น
- รูปถ่ายคู่เอกสารต้องปิดเลขบัตร ที่อยู่ วันเกิด ศาสนา กรุ๊ปเลือด และข้อมูลอื่นที่ไม่เกี่ยวข้อง ให้เหลือชื่อและภาพ ห้ามส่งหลังบัตร/Laser ID ไม่ทำ OCR หรือ face recognition
- รับ JPEG/PNG จริงเท่านั้น สูงสุด 5 MB / 20 ล้านพิกเซล จำกัดงานอัปโหลดพร้อมกัน 2 งานต่อ process ก่อนรับ body และไม่เขียนภาพต้นฉบับลง disk
- เจ้าของรับทราบ notice version และเลือกเหตุผล lost / replaced / damaged มีคำขอที่ยังพิจารณาได้ครั้งละหนึ่งคำขอ จำกัด 3 คำขอต่อวันต่อบัญชี/IP
- ภาพถูก normalize, ลบ metadata, จำกัดด้านยาว 1,600px, ใส่ลายน้ำ CUSA SSO/MFA RESET ONLY/เลขคำขอ/วันที่ แล้วเข้ารหัส AES-256-GCM ด้วยกุญแจสุ่มเฉพาะไฟล์ กุญแจเฉพาะไฟล์ถูก wrap ด้วย master key อีกชั้น AAD ผูกชนิดข้อมูลและ request ID ป้องกันการสลับไฟล์
- ผู้ดูแลต้องเป็น full TOTP session และยืนยันภายใน 5 นาทีเพื่อเปิดหลักฐานหรือตัดสินใจ การเปิดรูปเป็น authenticated API, no-store, ไม่มี public URL ของไฟล์
- ต้องเปิดตรวจหลักฐานภายใน 30 นาทีก่อนอนุมัติ และยืนยันกับเจ้าของผ่านช่องทางที่มีอยู่เดิม รูปที่ดูสมจริงอย่างเดียวไม่ยืนยันว่าเป็นเจ้าของบัญชี ห้ามขอ OTP/Recovery code ของผู้ใช้มาพิสูจน์
- ห้ามตรวจ/ตัดสินใจคำขอตัวเอง บัญชี Admin ต้องได้รับการอนุมัติจากผู้ดูแล **สองคนอื่นที่แตกต่างกัน** ผู้อนุมัติคนแรกต้องยังมีสิทธิ์อยู่ตอนคนที่สองอนุมัติ หากระบบมีผู้ดูแลไม่พอ ต้องใช้ Recovery code หรือกระบวนการ DBA นอกระบบที่ตรวจตัวตนและบันทึกการดำเนินการ ไม่มี self-approve/bypass endpoint
- คำขอผูก digest ของ TOTP secret เดิม หากผู้ใช้ผูกเครื่องใหม่ก่อนอนุมัติ คำขอเก่าใช้ถอดเครื่องใหม่นั้นไม่ได้ ให้ปฏิเสธคำขอเก่า
- อนุมัติแล้วลบ TOTP secret, Recovery codes, enrollment และ sessions ทั้งหมดพร้อม authorization codes/access tokens ที่ผูกอยู่ ใน transaction เดียวกับ audit outbox การตอบ introspection ที่ cache ไว้อาจคงอยู่สูงสุด TTL 5 วินาทีตามนโยบาย SSO
- ผู้ใช้เข้า Google ใหม่ → ยืนยัน email OTP → ผูก Authenticator เครื่องใหม่ ผู้ดูแลยังถูกบังคับ enroll ก่อนเข้า Admin API ผู้ใช้ทั่วไปตั้งได้ใน Security
- ไม่มีการส่งรูปเข้า Google/Gmail และไม่มีอีเมลแจ้งอนุมัติอัตโนมัติในรุ่นนี้ ผู้ใช้ตรวจสถานะจากหน้า MFA หรือเข้าสู่ระบบใหม่หลังผู้ดูแลแจ้งผ่านช่องทางที่ตรวจแล้ว

## การเก็บและทำลาย

| สถานะ | กำหนดทำลายหลักฐาน |
| --- | --- |
| approved / rejected | ภายใน 7 วันหลังการตัดสินใจครั้งสุดท้าย |
| pending / pending_second | ไม่เกิน 30 วันหลังสร้างคำขอ |
| อัปโหลดล้มเหลว | รอบ cleanup ถัดไป |
| process หยุดกลางอัปโหลด | เก็บแถว uploading ไว้ติดตามและ cleanup หลัง 1 ชั่วโมง |

Worker ภายในแอปรันตอน startup และทุก 15 นาทีเมื่อเปิด `BACKGROUND_JOBS_ENABLED` แต่ Plesk อาจพัก process งานจะกลับมาตรวจข้อมูลค้างเมื่อ process เริ่มใหม่ การรับประกัน deadline ระหว่าง downtime ต้องมี process ที่ทำงานตลอดหรือ scheduler ภายนอกตาม [คู่มือ HostAtom](HOSTATOM-RELEASE.md) Worker เริ่มลบล่วงหน้า 1 ชั่วโมงก่อน deadline เป็นระยะเผื่อ ห้ามอ่านรูปตั้งแต่ deadline แม้ job ยังทำไม่สำเร็จ ลบ `.key` ก่อน `.enc` ทำซ้ำได้หลัง crash/rollback และบันทึก `purged_at` กับ `mfa.reset.evidence.destroyed` โดยไม่เก็บภาพใน audit

หนึ่งรอบทำไม่เกิน 100 คำขอ ใช้ `FOR UPDATE SKIP LOCKED` ต่อคำขอ ตรวจ backlog/พื้นที่ disk และเพิ่มความถี่หากปริมาณมาก การหยุด Host/job หรือ filesystem เสียทำให้ลบไม่สำเร็จ ต้อง alert และแก้ทันที ห้ามอ้างว่าการหมดอายุใน DB เท่ากับทำลายไฟล์แล้ว

การ unlink/ลบกุญแจช่วยให้แอปเข้าถึงไฟล์ต่อไม่ได้ แต่ไม่ใช่การรับรอง physical overwrite ของ SSD/สำเนาที่บุคคลภายนอกทำไว้ ห้ามผู้ดูแลดาวน์โหลด ส่งต่อ หรือ screenshot หลักฐานนอกกระบวนการที่ได้รับอนุญาต ไม่สามารถห้ามการคัดลอกโดยผู้ที่มีสิทธิ์เห็นภาพด้วยโค้ดทั้งหมดได้

ข้อมูลคำขอ/สถานะ/ผู้ตัดสินใจและ Audit ที่ไม่มีรูปยังอยู่ตาม retention ของสมาคม มี `purged_at` สำหรับยืนยันงานลบ ต้องกำหนดรอบทบทวน/ลบ metadata และ audit แยกใน [Audit runbook](AUDIT-OPERATIONS.md) ไม่เก็บบุคคลตลอดไปโดยอัตโนมัติ

## API

ทุก mutation ใช้ Origin และ X-CSRF-Token ของ session ไม่มี API-key endpoint สำหรับรีเซ็ต

| Method / path | สิทธิ์ / ข้อมูล |
| --- | --- |
| GET `/api/auth/mfa-reset` | Google pending/full session; คืนคำขอตัวเองล่าสุด, enabled, noticeVersion |
| POST `/api/auth/mfa-reset` | multipart: evidence, reason, noticeVersion=`2026-09-30`, acknowledged=`true`; 201 `{id,status:"pending"}` |
| GET `/api/admin/mfa-resets?status=pending&cursor=...` | TOTP Admin; keyset ครั้งละ 50, `{requests,meta:{hasMore,nextCursor}}`; เก็บ cursor และ status เดิมเมื่อโหลดหน้าใหม่ |
| GET `/api/admin/mfa-resets/:id/evidence` | TOTP Admin ภายใน 5 นาที; คืน JPEG ที่ถอดรหัสพร้อมลายน้ำ ไม่ cache; บันทึก audit ทุกครั้ง |
| POST `/api/admin/mfa-resets/:id/decision` | fresh TOTP Admin; approve `{decision:"approve",verified:true,reason:"identity_verified"}` หรือ reject พร้อมเหตุผลด้านล่าง |

เหตุผล reject: `unreadable`, `identity_mismatch`, `insufficient_evidence`, `withdrawn` ไม่รับข้อความอิสระที่อาจคัดลอกเลขบัตรเข้า audit

ข้อผิดพลาดสำคัญ: 400 validation/image, 401 session expired, 403 MFA_REAUTH_REQUIRED / SELF_REVIEW / SECOND_REVIEWER_REQUIRED / EVIDENCE_REVIEW_REQUIRED, 404 EVIDENCE_UNAVAILABLE, 409 RESET_PENDING / RESET_DECIDED / RESET_UNAVAILABLE, 413 UPLOAD_LIMIT, 429 quota, 503 EVIDENCE_NOT_CONFIGURED / UPLOAD_BUSY

## กฎหมายและการอนุมัตินโยบายองค์กร

ระยะ **7 วันเป็นนโยบายที่ผู้ดูแลระบบกำหนด** ไม่ใช่ระยะที่ PDPA บังคับทุกกรณี [พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562](https://ratchakitcha.soc.go.th/documents/17082307.pdf) กำหนดหลักความจำเป็น การแจ้งวัตถุประสงค์/ระยะเก็บ และหน้าที่ด้านความปลอดภัย/การลบเมื่อหมดความจำเป็นตามมาตรา 22, 23 และ 37; การมีข้อมูลอ่อนไหวต้องพิจารณามาตรา 26 เพิ่มเติม

สมาคมควรให้ผู้รับผิดชอบกฎหมาย/ข้อมูลส่วนบุคคลรับรองฐานประโยชน์โดยชอบด้วยกฎหมายและการประเมินผลกระทบ/ความจำเป็นของวิธีนี้ก่อนเปิดรับภาพจริง ช่องรับทราบไม่ทดแทนฐานกฎหมาย หากพบข้อมูลอ่อนไหวที่ไม่ได้ปิดไว้ ให้จำกัดการใช้ ปฏิเสธ และประสาน DBA เพื่อทำลายก่อนกำหนดโดยไม่เปิดเผยข้อมูลในบันทึก มีทางเลือกติดต่อสมาคมหากไม่สามารถส่งภาพได้

ไม่มีปุ่มยืดอายุเอกสารหรือ legal-hold แบบไม่จำกัดในแอป หากมีคำสั่งทางกฎหมายจริงต้องให้ผู้รับผิดชอบพิจารณาขอบเขตและกระบวนการแยกก่อนถึงกำหนด ไม่ปล่อย job หยุดเงียบ ๆ เพื่อเก็บต่อ

## เมื่อบัญชีมี Passkeys หรือ LINE

การอนุมัติรีเซ็ต MFA ล้าง Passkeys, LINE binding และ challenge เพิ่มเติมด้วย พร้อม TOTP/Recovery/session เดิม ป้องกันอุปกรณ์ที่สูญหายใช้วิธีสำรองกลับเข้าบัญชี เบอร์ที่ยืนยันผ่าน Firebase คงไว้เป็นข้อมูลยืนยันเบอร์และไม่สามารถใช้แทน MFA ได้ การลบ/เปลี่ยนเบอร์หรือข้อมูลฝั่ง Firebase ต้องดำเนินการตามคำขอใช้สิทธิและผู้ให้บริการแยก ไม่อ้างว่าลบ provider data แล้วโดยการลบ row ใน CUSA
