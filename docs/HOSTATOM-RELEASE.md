# อัปโหลด CUSA SSO รุ่นนี้บน HostAtom / Plesk

รุ่น 4 ตุลาคม 2026 ต้อง migrate ถึง `007_waiting_room.sql` ก่อน Restart แม้ยังไม่เปิดคิว Migration เพิ่ม columns ใน `applications` ไม่มีตารางหรือ grants ใหม่ถ้า runtime มีสิทธิ์ตารางนี้ครบแล้ว อ่าน [คู่มือคิว](WAITING-ROOM.md) ส่วน scheduler ใช้ `BACKGROUND_JOBS_ENABLED=true` ไม่ต้องตั้ง Plesk Cron

ห้าม rollback ไป build ที่ไม่มี queue gate ขณะ Service ยังเปิดคิว เพราะ build เก่าจะไม่บังคับคิว ต้องหยุดรับงานและเปลี่ยน policy โดยผู้มีสิทธิ์พร้อม audit ก่อนพิจารณาย้อนรุ่น

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
9. เปิดงานเบื้องหลังใน Node ตามหัวข้อถัดไป ตรวจ log การทำงานก่อนเปิดรับภาพจริง ยืนยันว่าไฟล์ใน MFA_EVIDENCE_DIR คงอยู่ข้าม restart/deploy และไม่อยู่ใต้ Document Root ของเว็บไซต์อื่นด้วย

คำสั่ง `db:migrate:production` / `db:bootstrap:production` ใช้ไฟล์ JavaScript ที่ build แล้ว ไม่ต้องติดตั้ง tsx ใน production โดย bootstrap ใช้เฉพาะการติดตั้งครั้งแรกเท่านั้น

## งานอัตโนมัติใน Node.js (วิธีหลักสำหรับ Host นี้)

ตั้งค่าใน `.env` บน Host หรือ Plesk Custom Environment Variables แล้ว build และ Restart App:

```dotenv
BACKGROUND_JOBS_ENABLED=true
INSTALL_ENABLED=false
MFA_EVIDENCE_DIR=./var/mfa-evidence
```

`BACKGROUND_JOBS_ENABLED` มีค่าเริ่มต้นเป็น `true`; ตัว scheduler ไม่เพิ่มตารางหรือ dependencies ใหม่ ส่วนคิวต้องใช้ migration 007 หากอัปเดตผ่าน Git ต้อง `npm ci --include=dev` แล้ว Run script `build` ก่อน Restart App ไฟล์ `dist` ไม่ได้อยู่ใน Git คงกุญแจเข้ารหัสเดิมและข้อมูลใน `var` ไว้

| ชื่องานใน log | หน้าที่ | รอบปกติหลังงานครั้งก่อนเสร็จ |
| --- | --- | --- |
| `evidence_purge` | ลบหลักฐานที่ถึงช่วงทำลายตามนโยบายเดิม | 15 นาที |
| `operations_check` | ตรวจสิทธิ์ DB, audit backlog และหลักฐานเกินกำหนด | 5 นาที |
| `expired_credentials` | ล้าง session, OTP, token, OAuth flow, factor challenge และ rate counter ที่หมดอายุเป็น batch | 60 นาที |

ทุกงานตรวจข้อมูลค้างหนึ่งรอบเมื่อ process เริ่มทำงาน จากนั้นรันด้วย Node timers ใน process เดียวกับ API ไม่ต้องตั้ง Plesk Cron หรือเรียก PHP ตัวกลางในโหมดนี้ งาน I/O ใช้ฟังก์ชัน async เดิมและจำกัดจำนวนแถวต่อ batch; ลำดับภายใน process ทำทีละงาน เพื่อไม่ใช้ pool หลาย connection พร้อมกันสำหรับงานดูแลระบบ

แต่ละงานใช้ MariaDB `GET_LOCK(..., 0)` บน connection เดียวกับ SQL/transaction จึงไม่รันซ้อนกับงานชื่อเดียวกันบน process อื่นหรือ CLI เมื่อ lock ไม่ว่างจะข้ามรอบและลองใหม่ใน 30 วินาที ไม่ถือว่ารอบนั้นสำเร็จ ไม่ได้อ้าง exactly-once: process ต่างกันอาจตรวจซ้ำหลังอีก process ทำเสร็จได้ งานลบใช้เงื่อนไขวันหมดอายุและทำซ้ำได้ ส่วน lock ไม่ต้องเพิ่มตารางหรือให้สิทธิ์ DDL

เมื่อทำงานผิดพลาดจะเขียน error ลง stderr และลองใหม่ใน 60 วินาที งานอื่นยังเดินต่อได้ การหยุดแอปยกเลิก timer และหยุดระหว่าง batch โดยรอ batch ปัจจุบันก่อนปิด DB pool ภายใต้ shutdown timeout ของ server; ถ้าถูก force stop จะตรวจข้อมูลค้างใหม่หลังเริ่ม process ไม่ยิงรอบเก่าที่พลาดทั้งหมดพร้อมกัน

ตรวจผลจาก **Plesk → Logs** ที่รับ stdout/stderr ของ Node:

```json
{"event":"background.scheduler.started","jobs":[{"name":"evidence_purge","intervalMs":900000},{"name":"operations_check","intervalMs":300000},{"name":"expired_credentials","intervalMs":3600000}]}
{"event":"background.job.completed","job":"evidence_purge","deleted":0}
```

`background.job.failed` มีชื่อ job และเหตุผลแบบไม่เปิดเผย credentials/SQL/ข้อมูลในภาพ; `background.job.skipped` หมายถึงมี process อื่นถือ lock อยู่ และ `background.scheduler.disabled` หมายถึงปิด flag, config ยังไม่ครบ หรืออยู่ในโหมดติดตั้ง ถ้า operations แจ้ง `Runtime has excessive rights ...` ต้องแก้สิทธิ์ DB ตามคู่มือ ไม่ใช่ปิดงานตรวจเพื่อซ่อนข้อความ

ถ้าเปิด `METRICS_TOKEN` อยู่ `/api/metrics` เพิ่มสถานะ scheduler, งานที่กำลังรัน, เวลาสำเร็จล่าสุด และจำนวนความผิดพลาดต่อเนื่อง โดยต้องส่ง Bearer token เดิม ค่าสถานะเป็นของแต่ละ process และเริ่มนับใหม่หลัง restart ไม่มี API สาธารณะสำหรับสั่งงานลบ และ log/metrics ไม่ได้ส่งอีเมลแจ้งเตือนให้อัตโนมัติ

คำสั่ง Run script `evidence:purge`, `ops:check`, `db:cleanup` ยังใช้รันมือได้ ใช้ lock เดียวกับ server และ error ส่งออก stderr/exit code 1; หากงานชื่อเดียวกันกำลังทำงานอยู่จะแสดง `ALREADY_RUNNING` แทนการเริ่มซ้ำ

**ข้อจำกัด:** timers ทำงานเฉพาะขณะที่ Node process ยังรัน หาก Passenger พักแอปหรือ Host ล่ม งานทั้งหมดจะหยุดจนแอปกลับมา การใช้ timer ไม่ใช่การตั้งค่าให้ Passenger ทำงานตลอดเวลา และการตรวจงานค้างเมื่อเริ่มใหม่ไม่รับประกันว่าจะลบหลักฐานทัน deadline ระหว่าง downtime หากต้องรับประกันเวลา ต้องให้ Host คง process ไว้หรือจัด worker ภายนอกที่ทำงานตลอด ในโหมดปัจจุบันต้องติดตาม log และทดสอบการพัก/ปลุกบน Host จริง

อ้างอิง: [Node timers](https://nodejs.org/api/timers.html), [MariaDB advisory locks](https://mariadb.com/docs/server/reference/sql-functions/secondary-functions/miscellaneous-functions/get_lock), [Passenger minimum instances](https://www.phusionpassenger.com/docs/references/config_reference/nginx/#passenger_min_instances)

## Scheduled Tasks ภายนอก (ทางเลือกเมื่อ Host รองรับ)

วิธีด้านล่างเก็บไว้สำหรับกรณีต้องรันงานแยกจาก process เว็บ หากเลือกใช้ภายนอกครบทั้งสามงานแล้ว ให้ตั้ง `BACKGROUND_JOBS_ENABLED=false` เพื่อหยุดตารางภายใน ห้ามปิดโดยยังไม่มีงานทดแทนที่ทดสอบแล้ว

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

### Run script ผ่าน แต่ Scheduled Task หา Node ไม่พบ

หาก `Node.js → Run script → evidence:purge` สำเร็จ แต่ Scheduled Task ขึ้น `node: command not found` ให้หาตำแหน่ง Node จาก **Node.js → Run Node.js commands** โดยเลือก npm และใส่คำสั่งต่อไปนี้ (หากช่องรับคำสั่งเต็ม ให้เติม `npm` ด้านหน้า):

```sh
exec --offline --call="node -p 'JSON.stringify({node:process.execPath,version:process.version,cwd:process.cwd()})'"
```

คำสั่งแสดงเฉพาะ path, เวอร์ชัน และโฟลเดอร์ทำงาน ไม่โหลด `.env` หรืออ่านข้อมูลใน DB ใช้ [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/) ในโหมด offline

ในการตรวจ Host วันที่ 1 ตุลาคม 2026 หน้า Node.js รายงาน Node `/opt/plesk/node/25/bin/node` และ Application Root `/var/www/vhosts/scicu-alumni.com/sso.reunion.scicu-alumni.com` แต่ Scheduled Task เรียก Node ที่ path เดียวกันแล้วขึ้น `No such file or directory` ข้อมูลนี้ยืนยันความแตกต่างของสภาพแวดล้อมที่รัน ยังไม่ยืนยันการตั้งค่า chroot ของ Host และไม่ใช่เหตุให้เปลี่ยนเวอร์ชัน/path ตามการคาดเดา

ให้ HostAtom ตรวจ shell/chroot ของ subscription และเพิ่ม Node พร้อม libraries ที่จำเป็นในสภาพแวดล้อม Scheduled Task หรือจัดงานด้วยวิธีที่ Host รองรับโดยรันภายใต้ system user ของเว็บไซต์ ขั้นตอนนี้เป็นการตั้งค่าของ Host ไม่ได้แก้ด้วยการ build ซ้ำหรือเปลี่ยน `.env` ตาม [Plesk: Scheduled Task หา executable ไม่พบ](https://support.plesk.com/hc/en-us/articles/12377854405655-A-scheduled-task-executed-under-a-subscription-user-fails-in-Plesk-No-such-file-or-directory)

ตัวอย่างข้อความส่ง Support (ปรับ Node path ตามผลตรวจล่าสุด):

> โดเมน sso.reunion.scicu-alumni.com รัน evidence:purge ผ่านหน้า Node.js สำเร็จแล้ว แต่ Scheduled Task เรียก /opt/plesk/node/25/bin/node แล้วขึ้น No such file or directory กรุณาตรวจ shell/chroot และทำให้บัญชีเว็บไซต์เรียก Node พร้อม dependencies ได้จาก Scheduled Task หรือจัด cron ด้วยวิธีที่ Host รองรับ ต้องการรัน server/dist/scripts/purgeMfaEvidence.js ภายใต้ Application Root ทุก 15 นาที โดยอ่าน .env, เชื่อมต่อ MariaDB และอ่าน/ลบไฟล์ใน MFA_EVIDENCE_DIR ได้ กรุณาแจ้ง Node path และ Application Root ที่มองเห็นจากบริบท Scheduled Task และทดสอบ Run Now ให้ด้วย

หลัง Host ปรับแล้ว:

1. ทดสอบ `<NODE_BINARY> --version` ใน **Scheduled Tasks → Run Now** ให้ผ่านก่อน
2. ใช้ path ของ Node และ Application Root ที่ Host ยืนยันรัน `purgeMfaEvidence.js` ให้ได้ `mfa.evidence.purge.completed`
3. ตั้ง Cron style เป็น `*/15 * * * *`, Description เป็น `CUSA ลบหลักฐานที่ครบกำหนด`, Notify เป็น `Errors only` แล้วบันทึก ตรวจผลของรอบอัตโนมัติครั้งถัดไปด้วย

เมื่อเปิด `BACKGROUND_JOBS_ENABLED=true` แอปมี worker ทั้งสามงานตามหัวข้อด้านบนอยู่แล้ว แต่จะทำงานเฉพาะระหว่าง process ยังทำงาน; ถ้า Passenger หยุด process หรือแอปล่ม worker ภายในจะไม่รัน การรันด้วยมือสำเร็จหรือ `deleted:0` ไม่ได้ยืนยันว่า cron ภายนอกถูกตั้งแล้วหรือระบบทำลายหลักฐานได้ตามกำหนดทุกกรณี

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

## ส่วนขยาย Passkeys / LINE / Firebase

ส่วนนี้ใช้ migration `006_additional_factors.sql`; รุ่นปัจจุบันรวมทั้งหมด 7 migrations ต้องรันก่อนเปิด Node รุ่นใหม่แม้ยังปิด LINE/Firebase/คิวอยู่ อ่าน [คู่มือตั้งค่าทีละช่อง](ADDITIONAL-FACTORS.md) ค่าที่เพิ่มใน `.env.example` ยังไม่แทน credentials ของ Host ให้คงค่าเดิมและเติมเฉพาะช่องใหม่

Passkeys เปิดได้โดย `PASSKEY_ENABLED=true`; LINE/Firebase คง false จนใส่ค่าครบและทดสอบจริง Browser SDK Firebase โหลดเมื่อผู้ใช้ขอยืนยันเบอร์ ไม่เก็บ Firebase token ใน localStorage

`npm run deploy:check` ตรวจไฟล์/config ในเครื่องนั้นเท่านั้น ส่วน `npm run ops:check` ตรวจ schema 006/สิทธิ์อ่านตารางใหม่และ audit health ผ่านฐานข้อมูลจริง หาก runtime เป็นบัญชี Plesk ที่มี ALL PRIVILEGES เดิม ยังต้องให้ Host ปรับตาม runtime-grants; การติดตั้ง migration ไม่จำกัดสิทธิ์ให้อัตโนมัติ

เลือก `DB_SOCKET_PATH` เฉพาะเมื่อ HostAtom แจ้ง path ที่ Node เข้าถึงได้ ไม่เดา path ของเครื่องพัฒนา และไม่เปลี่ยนจาก localhost TCP เพียงเพราะคาดว่าจะเร็วขึ้น ทั้งสองแบบยังใช้ pool/UTC เหมือนกัน

เปิด Monitoring เพิ่มได้ด้วย `METRICS_TOKEN`; ดู [Delta Review](DELTA-REVIEW.md) ค่า metrics เป็นราย process ไม่ใช่ค่ารวม Host/Passenger
