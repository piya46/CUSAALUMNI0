# อัปโหลด CUSA SSO รุ่นนี้บน HostAtom / Plesk

สำหรับโดเมน `sso.reunion.scicu-alumni.com` ที่ติดตั้งระบบไว้แล้ว ขั้นตอนนี้ไม่สร้าง Database ใหม่และไม่เปิด `/install` ซ้ำ อ่าน [คู่มือติดตั้ง](INSTALL.md) แยกหากเป็นฐานข้อมูลว่างจริง

## เตรียม ZIP จากเครื่องพัฒนา

รัน `npm run deploy:package` ที่ Application Root ของโปรเจกต์ ต้องมี Node, dependencies สำหรับ build และคำสั่ง `zip` บนเครื่องที่แพ็ก จะ build ด้วย NODE_ENV=production เสมอแล้วสร้างไฟล์ใน `releases/` พร้อม `.sha256`

ZIP มี source, production build, migrations, package-lock และคู่มือ มี `release-manifest.json` แสดง SHA-256 ของแต่ละไฟล์ ไม่รวม `.env` จริง, node_modules, `.git`, โฟลเดอร์ `var`, หลักฐาน/กุญแจ, source maps หรือรายงานทดสอบ ระบบปฏิเสธ symlink/ไฟล์ลับที่ปะปนในโฟลเดอร์ source และตรวจค่าลับที่ตั้งไว้ใน `.env`/environment โดยไม่พิมพ์ค่าออกมา การตรวจนี้ไม่ทดแทนการตรวจ source ที่ผู้พัฒนาเพิ่มเอง

ไม่ต้องนำ `.env` ออกจาก Host หรือสร้างกุญแจเดิมใหม่เพื่ออัปเดต ZIP หากยังไม่มีกุญแจ MFA evidence ให้ตั้งกุญแจใหม่เฉพาะฟีเจอร์นั้นตาม [คู่มือ MFA](MFA-RESET.md) ก่อนเปิดรับเอกสาร

## ค่าใน Plesk สำหรับโดเมนนี้

| ช่อง | ค่า |
| --- | --- |
| Application Root | `/sso.reunion.scicu-alumni.com` — โฟลเดอร์ที่มี package.json |
| Document Root | `/sso.reunion.scicu-alumni.com/public` — คงโฟลเดอร์ว่าง |
| Startup File | `app.cjs` |
| Application Mode | Production |
| Application URL | `https://sso.reunion.scicu-alumni.com` |

Node ต้องรองรับอย่างน้อย 22.12 เลือกรุ่นที่ผู้ให้บริการรองรับและทดสอบไว้ เส้นทางในตารางเป็นตัวเลือกภายใน webspace ไม่ใช่ root filesystem ของ Linux

## ขั้นตอนอัปเกรดระบบเดิม

1. กำหนดช่วง maintenance สำรอง DB และกุญแจระบบในพื้นที่จำกัดสิทธิ์ **ยกเว้นไฟล์หลักฐาน MFA และ wrapped keys จาก backup/snapshot** ตาม retention ที่ประกาศไว้
2. Upload ZIP ผ่าน File Manager และ extract ใน Application Root โดยให้ `package.json` อยู่ระดับเดียวกับ `app.cjs` อย่า extract ซ้อนอีกชั้น คง `.env` และ `var` เดิมไว้ แพ็กเกจไม่มีสองรายการนี้และไม่ลบไฟล์เก่าบน Host ให้เอง
3. ติดตั้ง dependencies ด้วย Node/npm ของ Plesk: `npm ci --omit=dev` เพราะ ZIP มี build แล้ว หากอัปโหลด source โดยไม่มี build ให้ใช้ `npm ci --include=dev` แล้ว `npm run build` ตามคู่มือเดิม ไม่คัดลอก node_modules จาก macOS
4. ตรวจ `.env` ของ Host: NODE_ENV=production, HTTPS APP_ORIGIN หนึ่งค่า, INSTALL_ENABLED=false และ INSTALL_TOKEN ว่าง DB_HOST=localhost/127.0.0.1 กับ DB_TLS=false ใช้ได้เฉพาะเมื่อ Node และ MariaDB อยู่เครื่องเดียวกันตามข้อมูล Host เท่านั้น ห้ามใช้ public IP กับ DB_TLS=false ใน production
5. ใน **Node.js → Run script** เลือก `deploy:check` หรือรัน `npm run deploy:check` จาก Terminal เป็นการตรวจไฟล์และค่าตั้งต้นแบบ offline; ไม่รัน SQL, ไม่ทดสอบ Google/Gmail และไม่แก้ `.env` Exit code 1 หมายถึงมีรายการ fail ที่ต้องแก้ตามชื่อ check
6. ใช้บัญชี migration ที่มีสิทธิ์ DDL รัน `npm run db:migrate:production` จาก Application Root เพื่อเพิ่ม migrations ที่ยังไม่มี รวม 004/005 ห้ามแก้ checksum หรือไฟล์ migration ที่เคยใช้แล้ว ไม่รัน bootstrap ซ้ำสำหรับระบบเดิม
7. เปลี่ยนกลับเป็นบัญชี runtime ตาม [runtime-grants.sql](../server/sql/runtime-grants.sql) แล้วรัน `npm run ops:check` ต้องไม่มี excessive grants, timezone ผิด, backlog หรือหลักฐานเกินกำหนด หาก Host ไม่ให้ตั้ง table grants ให้ HostAtom จัดสิทธิ์ให้ตามไฟล์นี้ก่อนยืนยันว่า audit เป็น append-only ในระดับ DB
8. Restart App แล้วตรวจ `/api/ready` ผ่าน HTTPS, Google Login/OTP/Ref/TOTP และ Service callback ด้วยบัญชีทดสอบที่ได้รับอนุญาต การตรวจ offline ผ่านไม่ยืนยันว่าขั้นตอนเหล่านี้ทำงานบน Host แล้ว
9. ตั้ง Scheduled Tasks ด้านล่าง และตรวจ `Run Now` ก่อนเปิดรับภาพจริง ยืนยันว่าไฟล์ใน MFA_EVIDENCE_DIR คงอยู่ข้าม restart/deploy และไม่อยู่ใต้ Document Root ของเว็บไซต์อื่นด้วย

คำสั่ง `db:migrate:production` / `db:bootstrap:production` ใช้ไฟล์ JavaScript ที่ build แล้ว ไม่ต้องติดตั้ง tsx ใน production โดย bootstrap ใช้เฉพาะการติดตั้งครั้งแรกเท่านั้น

## Scheduled Tasks

เปิด **Websites & Domains → Scheduled Tasks → Add Task → Run a command** เลือกตารางแบบ Cron style และตั้งการแจ้งเตือนเมื่อทำงานผิดพลาด ใช้ system user ของ subscription ที่รันแอปและอ่าน `.env`/หลักฐานได้ ไม่ใช้ root โดยไม่จำเป็น

หา Node executable ที่ตรงกับตัวแอปจากหน้า Run Node.js commands หรือให้ HostAtom แจ้ง แล้วแทน `<NODE_BINARY>` และ `<APP_ROOT>` ในตารางด้วย path ที่ Scheduled Task มองเห็น:

| งาน | Cron | Command |
| --- | --- | --- |
| ลบหลักฐานถึงกำหนด | `*/15 * * * *` | `<NODE_BINARY> <APP_ROOT>/server/dist/scripts/purgeMfaEvidence.js` |
| ตรวจสิทธิ์ DB, queue, เอกสารเกินกำหนด | `*/5 * * * *` | `<NODE_BINARY> <APP_ROOT>/server/dist/scripts/operationsCheck.js` |
| ลบ session/OTP/token ที่หมดอายุ | `17 * * * *` | `<NODE_BINARY> <APP_ROOT>/server/dist/scripts/cleanup.js` |

ถ้า path มีช่องว่างให้ครอบด้วย single quotes และอย่าใส่ secrets ใน command line สคริปต์หา `.env` จาก Application Root ของตัวเอง จึงไม่ต้องเปลี่ยน working directory สำหรับคำสั่ง Node โดยตรง หากใช้ `npm run ...` ต้องรันจาก Application Root

อย่าสมมติว่า Custom Environment Variables ของหน้า Node.js จะถูกส่งให้ Scheduled Tasks ด้วย ให้ใช้ `.env` ของ Host ที่จำกัดสิทธิ์ 0600 หรือวิธีโหลด secret ที่ Host รองรับ แล้วทดสอบจริงทั้งสอง context ห้ามเปลี่ยนกุญแจเข้ารหัสเดิมทับเพื่อให้ job ผ่าน

**Plesk อาจรัน task ใน chroot:** ถ้าขึ้น “file not found” ทั้งที่ Node ทำงานบนหน้าเว็บ ให้ตรวจ path ภายใน chroot กับ HostAtom ไม่ควรแก้ด้วย chmod777 หรือปิดการแยก tenant ทั้งระบบ กด Run Now และตรวจ exit code/output ของแต่ละ task ก่อนบันทึก ตาม [คู่มือ Scheduled Tasks ของ Plesk](https://docs.plesk.com/en-US/obsidian/customer-guide/scheduling-tasks.65207/)

Purge สำเร็จจะแสดง `mfa.evidence.purge.completed` พร้อมจำนวนไฟล์คำขอที่จัดการ; จำนวน 0 เป็นปกติเมื่อยังไม่มีรายการถึงกำหนด `ops:check` ต้องได้ `ok:true` และตั้งช่องทางรับแจ้งเตือน exit code ที่ไม่ใช่ 0 ทั้ง job ลบและ job ตรวจสอบ การตั้งแจ้งเตือนทำผ่าน Plesk/ระบบ monitoring ของสมาคม โค้ดนี้ไม่ได้ส่งอีเมลหาคนอื่นแทนการตั้งค่าเหล่านั้น

## ตรวจหลังเปิดใช้งาน

- ตรวจว่าดาวน์โหลด `.env`, `var/...`, `server/...` ผ่านเว็บไซต์ไม่ได้ (หน้า React fallback ไม่ใช่เนื้อหาไฟล์จริง) ห้ามเลือก Application Root เป็น Document Root
- ตรวจ proxy ด้วย X-Forwarded-For จำลองจากภายนอกตาม [คู่มืออัปเกรด](SECURITY-UPGRADE.md) เก็บ client IP และ peer IP แยกกัน
- ทดลองรีเซ็ต MFA ด้วยภาพจำลองก่อน: owner ส่ง, Admin ยืนยัน TOTP ใหม่, เปิดตรวจ, อนุมัติ, เซสชันเดิมถูกถอน, งานลบทำงานใน staging
- ตรวจ Google branding ตาม [คู่มือ Google](GOOGLE-BRANDING.md) การ upload ZIP ไม่ยืนยัน DNS ownership ให้
- ใช้ checksum ของ ZIP ตรวจความครบถ้วนระหว่างส่งไฟล์ แต่ checksum ที่อยู่ข้าง ZIP ไม่ใช่ลายเซ็นยืนยันผู้เผยแพร่

หากย้อนกลับให้ใช้ release ก่อนหน้ากับ DB schema ที่เพิ่มแบบ additive แล้ว โดยคง migration history และโฟลเดอร์หลักฐาน/กุญแจไว้ ห้ามลบ migrations หรือ `var` เพื่อแก้ปัญหาหน้าเว็บ

## หากใช้ Docker ในอนาคต

Compose รุ่นนี้ mount named volume `mfa_evidence` ที่ `/app/var/mfa-evidence` และกำหนดสิทธิ์ให้ Node ใน image มีฟอนต์สำหรับลายน้ำ Latin ใช้ volume เดิมข้ามการสร้าง container ใหม่ และยกเว้น volume นี้จาก backup/snapshot เพราะมีหลักฐานกับ wrapped keys ห้ามใช้ `docker compose down -v` ระหว่างมีคำขอค้าง

Volume ช่วยให้ข้อมูลอยู่ต่อหลังเปลี่ยน container แต่ไม่ใช่ระบบสำรองข้อมูล และ local Docker volume ไม่ได้แชร์ข้ามหลาย Host โดยอัตโนมัติ ต้องทดสอบสิทธิ์เขียน/อ่าน/ลบด้วยภาพจำลองบน Docker จริงก่อนใช้งาน ตาม [Docker volumes](https://docs.docker.com/engine/storage/volumes/)
