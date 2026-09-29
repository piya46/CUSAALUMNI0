# CUSA SSO

ระบบ User Management และ SSO ด้วย **Node.js / Express + React + MariaDB** ตามโครงสร้าง **MVC** พร้อมหน้าเว็บภาษาไทย รองรับ Google Login, Email OTP, Authenticator TOTP, recovery codes, allowlist, API keys และ API ยืนยันตัวตนสำหรับระบบภายใน

## เริ่มดูหน้าเว็บ

ต้องใช้ Node.js 22.12+ และ npm 10+

```sh
npm ci
npm run dev
```

เปิด **http://localhost:5173** แล้วเลือกโหมดสาธิตจากหน้าเข้าสู่ระบบ ข้อมูลสาธิตอยู่ในหน่วยความจำของหน้าเว็บและหายเมื่อ reload; ไม่ได้ล็อกอินผ่าน Google และไม่เข้าถึงฐานข้อมูลจริง

## เปิดใช้งานจริง

1. คัดลอก `.env.example` เป็น `.env` ที่ root แล้วตั้งค่าฐานข้อมูล, Google และ Gmail
2. สร้าง `SESSION_SECRET` กับ `ENCRYPTION_KEY` แยกกันด้วยคำสั่งด้านล่างสองครั้ง เก็บคีย์ไว้นอก repository
3. สร้าง database `cusa_identity` ใน MariaDB และเตรียมผู้ใช้สำหรับ migration แยกจากผู้ใช้ runtime
4. รัน migration และ bootstrap ผู้ดูแลระบบด้วยอีเมล Google ที่ยืนยันแล้ว
5. เข้า Google Login แล้วกรอก OTP อีเมล จากนั้นเปิด Authenticator ในหน้า Security และเก็บ recovery codes

```sh
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Run the key-generation command again for the other key.
npm run db:migrate
npm run db:bootstrap
npm run dev
```

`BOOTSTRAP_ADMIN_EMAIL` ใช้เฉพาะคำสั่ง bootstrap โดยไม่ยกระดับผู้ใช้ที่มีอยู่เงียบ ๆ และไม่เพิ่มผู้ดูแลใหม่นอกการตั้งค่าเริ่มต้น ตั้งค่า host เริ่มต้นตามที่ระบุเป็น `203.170.190.137`; ยังต้องกรอกชื่อ database, username/password จริง และ CA เพิ่มเติมเฉพาะกรณี private CA/self-signed ไม่มี migration อัตโนมัติเมื่อเปิดแอป

`DB_CA_FILE` เว้นว่างได้เมื่อ certificate ของฐานข้อมูลตรวจสอบกับ trusted CA ของ Node.js ได้ ระบบยังตรวจสอบ certificate และชื่อ host ตามปกติ หากใช้ private CA/self-signed ให้ขอ CA จากผู้ให้บริการฐานข้อมูล; การไม่มีไฟล์ CA ไม่ได้แปลว่าปิด TLS ได้

MariaDB 10.11+ ใช้ InnoDB, UTC และ TLS แบบตรวจสอบ certificate หาก certificate ออกให้ชื่อ DNS ให้ใช้ชื่อที่ชี้ไปยัง host นี้ หรือ certificate ที่มี IP ใน SAN; อย่าปิดการตรวจสอบ TLS สำหรับ production

## หน้า Login และสิทธิ์ของแต่ละ Service

หน้า `/login` ใช้เข้าสู่ระบบกลาง เว็บปลายทางเริ่มผ่าน `/api/sso/authorize` พร้อม PKCE แล้ว CUSA SSO จะแสดงชื่อและโดเมนที่ลงทะเบียนไว้ ผ่าน Google + MFA และกลับไปยังระบบเดิม

ชื่อ–นามสกุลอยู่ที่บัญชีกลาง หน่วยงานและหลาย Role แยกตาม Service ผู้ดูแลสร้าง Role เองและกำหนดสมาชิกได้ในเมนู **สิทธิ์แต่ละ Service** ต้องรัน migration `002_service_roles.sql` และกำหนดสมาชิกให้ผู้ใช้เดิมก่อนใช้ SSO; ไม่มีการให้สิทธิ์ทุก Service อัตโนมัติ ดู [คู่มือสิทธิ์แต่ละ Service](docs/SERVICE-ACCESS.md) และ [คู่มือเชื่อมต่อ](docs/SSO-INTEGRATION.md)

## Google Login และการส่ง OTP

สร้าง OAuth client ชนิด Web application แล้วลงทะเบียน redirect URI ให้ตรงทุกตัวอักษร:

```text
http://localhost:5173/api/auth/google/callback
https://YOUR_DOMAIN/api/auth/google/callback
```

Google Login ขอเฉพาะ `openid email profile` และตรวจ signature, issuer, audience, nonce, verified email รวมถึง allowlist ฝั่ง server ใช้ Google `sub` เป็นตัวอ้างอิงบัญชี ไม่ใช้ email แทน stable identity ([Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect))

**บัญชีส่วนบุคคล `@gmail.com`:** ตั้ง `MAIL_MODE=gmail_oauth`, `GMAIL_SENDER` และ OAuth client สำหรับส่งเมล เปิด Gmail API และอนุญาต scope `https://www.googleapis.com/auth/gmail.send` แบบ offline เพื่อรับ refresh token ลง `GMAIL_REFRESH_TOKEN` ใช้ OAuth client ของคุณเองผ่าน flow ฝั่ง server หรือ Google OAuth Playground โดยตั้ง “Use your own OAuth credentials”; callback สำหรับการขอ token นี้ต้องลงทะเบียนด้วย หากเป็น consent screen แบบ Testing ให้ตรวจข้อจำกัดอายุ refresh token ก่อนใช้งานถาวร ค่าของ Gmail client แยกจาก Google Login ได้ ([Gmail server-side authorization](https://developers.google.com/workspace/gmail/api/auth/web-server))

**Google Workspace:** ตั้ง `MAIL_MODE=workspace_service_account`, อีเมลผู้ส่งในโดเมน Workspace, service account email และ private key ให้ Workspace super admin อนุมัติ domain-wide delegation เฉพาะ `gmail.send` ก่อน impersonate ผู้ส่ง การมอบสิทธิ์นี้ใช้แทนบัญชี `@gmail.com` ส่วนบุคคลไม่ได้ ([Google service accounts](https://developers.google.com/identity/protocols/oauth2/service-account))

Email OTP เป็นการยืนยันอีเมลซ้ำหลัง Google Login; หาก Google และ OTP ใช้ mailbox เดียวกัน จะไม่ใช่ปัจจัยอิสระเทียบเท่า Authenticator TOTP

## โครงสร้าง MVC

```text
server/src/
  models/         SQL, transactions, data access
  controllers/    HTTP request/response และ business workflow
  routes/         เส้นทาง API และ middleware
  middleware/     session, role, CSRF, validation, rate limit
  services/       crypto, TOTP, Gmail, cache, audit worker
  config.ts       environment validation
  db.ts           MariaDB connection pool
web/src/
  views/          React pages (View)
  components/     UI components
  models/         DTOs, API client, demo state
```

## พฤติกรรมความปลอดภัยที่มีในโค้ด

- Google authorization code + PKCE S256, state ผูกกับ browser cookie และ nonce แบบใช้ครั้งเดียว
- Session credential อยู่ใน HttpOnly cookie เท่านั้น; production ใช้ Secure, SameSite=Lax และ `__Host-` prefix หมุน token/CSRF หลังผ่าน MFA อายุคงที่ 8 ชั่วโมงโดยค่าเริ่มต้น
- OTP ใช้ Argon2id (19 MiB, 2 iterations, parallelism 1) กับ input ที่ผูก session และ keyed pepper; token/API key ที่สุ่มอย่างน้อย 32 bytes ใช้ HMAC-SHA-256 เพื่อค้นหาแบบ indexed; TOTP secret ใช้ AES-256-GCM
- MFA ผิด 5 ครั้งล็อกบัญชี 15 นาที, OTP อายุ 5 นาที, TOTP ป้องกันการใช้ time step ซ้ำ, recovery codes ใช้ได้ครั้งเดียวและมีผลหลังเปิด TOTP สำเร็จเท่านั้น
- เซสชันที่ผ่าน MFA พร้อมกันสูงสุด 3 อุปกรณ์; เปลี่ยน MFA แล้วเพิกถอนเซสชันอื่น
- ตรวจ Origin และ CSRF token สำหรับคำขอที่เปลี่ยนข้อมูล; RBAC ฝั่ง server, Zod validation, parameterized SQL, CSP และการจำกัดขนาด request
- allowlist removal / soft delete เพิกถอน session และ token; การเพิ่มอีเมลเดิมกลับเป็นการ restore ที่บันทึก audit และคง TOTP เดิมไว้
- rate limit ตัวกรอง IP ใน process + shared Redis หรือ MariaDB เมื่อไม่ได้ตั้ง Redis; หาก Redis ที่ตั้งไว้ล่มระบบปฏิเสธคำขอ ไม่มี fallback ที่รีเซ็ต counter
- API key แสดงครั้งเดียว, จำกัด scope/application/expiry; ถอน key จะหยุดการใช้ key นั้น แต่ access token ที่ออกก่อนหน้านั้นอาจใช้ต่อจนหมดอายุ 5 นาที การถอน application หรือ session ถอน token ที่ผูกด้วย

TOTP และ OTP policy อ้างอิงแนวทาง [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) ในส่วน Argon2id สำหรับ secret ที่ entropy ต่ำ ข้อมูล email ยังเก็บเป็นข้อความเพื่อรองรับ allowlist/search; field encryption ของ email ต้องออกแบบ blind index และการย้ายคีย์เพิ่มเติม

## SSO, cache และ audit

อ่าน [คู่มือเชื่อมต่อ SSO](docs/SSO-INTEGRATION.md) และ [คู่มือ Audit](docs/AUDIT-OPERATIONS.md) สำหรับ BFF, PKCE, introspection, CORS และ archive

API นี้เป็น SSO สำหรับแอปที่ admin อนุมัติ โดยใช้ `X-API-Key` เพื่อยืนยัน backend ของแอป **ยังไม่ใช่ OpenID Connect Provider ที่ผ่านการรับรอง** ไม่มี OIDC discovery, ID token หรือ refresh token ระบบลูกต้องเริ่ม authorization ใหม่หลัง access token 5 นาทีหมดอายุ (ใช้ session SSO ที่มีอยู่ได้)

Introspection cache ผูกทั้ง API key hash และ token hash จำกัด 10,000 entries และรวมคำขอพร้อมกันของคีย์เดียวกัน TTL สูงสุด 5 วินาทีและไม่เกิน token expiry ค่า `INTROSPECTION_CACHE_SECONDS=0` ปิด cache เมื่อต้องการตรวจ revocation ทันที การเปิด cache ยอมรับการเปลี่ยนสิทธิ์ช้าสูงสุด 5 วินาที และควรใช้ Redis สำหรับ shared rate limit เพื่อลด SQL ในเส้นทางนี้ ไม่เพิ่ม grace period ที่ทำให้ token หมดอายุยังใช้ได้; ตั้งเวลาเครื่องด้วย NTP

Pool ค่าเริ่มต้น 20 connections/instance, bounded queue 100, idle timeout 60 วินาที ตั้ง DB `max_connections` โดยรวมทุก instance, workers และงานดูแล เช่น 4 instances × 20 + 20 reserve = 100 เป็นจุดเริ่มประเมิน ต้อง load test ตาม RAM/CPU/query จริง ไม่ใช่การรับประกัน throughput

Audit เก็บ success/failure, actor snapshot, session record ID (ไม่ใช่ cookie credential), IP และ user agent คำขอรอการ enqueue ถาวร แล้ว worker ย้ายไป append-only logs แบบ transaction; ไม่ทิ้ง Promise แบบ fire-and-forget `/api/ready` ตรวจ DB และ backlog ของ audit ใช้ archive แยก credential และตรวจ checksum ก่อนวางแผน retention ขณะนี้ไม่มีการลบ audit อัตโนมัติหรือ hash chain

## Build, test, deploy

ถ้าใช้ Plesk บน Linux ให้ดู [คู่มือตั้งค่า Plesk](docs/PLESK.md): ใช้ Application Root ของโปรเจกต์, Document Root เป็น `public` ว่าง และ Startup File `app.cjs` เพื่อให้ Node.js ส่งหน้า React พร้อม Security Headers

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
# Set NODE_ENV=production and all required settings before starting production.
npm start
```

Database integration tests จะข้ามเมื่อไม่มี `RUN_DB_TESTS=1` และบังคับใช้เฉพาะ localhost ดูค่าที่จำเป็นใน [test environment](server/tests/test-env.ts) ทดสอบกับ database แยกเท่านั้น Browser tests ใช้ Chrome ที่ติดตั้งใน macOS หากไม่มี ให้รัน `npx playwright install chromium` ก่อนทดสอบ ชุดทดสอบ build แล้วเปิด server ชั่วคราว `127.0.0.1:4188` แบบไม่ตั้ง credentials เพื่อทดสอบ UI demo แยกจาก dev server อื่น

Docker deployment มี `Dockerfile`, `compose.yaml` และ Caddy สำหรับ HTTPS ตั้ง `APP_ORIGIN=https://YOUR_DOMAIN`, `SSO_DOMAIN`, credentials, verified DB TLS และ DNS ให้พร้อม รัน migration ด้วย role ที่มี DDL ก่อน จากนั้น `docker compose up --build -d` ตรวจ `/api/ready` หลังเริ่มระบบ หากใช้ custom CA ให้ mount file เข้า container ที่ `DB_CA_FILE` ระบุ Compose ไม่เปิด port ของ app หรือ Redis สู่ภายนอกโดยตรง

ตั้ง scheduled job รัน `npm run db:cleanup -w server` หรือ production `node server/dist/scripts/cleanup.js` เป็นระยะเพื่อลบเฉพาะ session/token/flow/rate counters ที่หมดอายุเป็น batch คำสั่งนี้ไม่ลบ audit logs หรือข้อมูลผู้ใช้

ก่อนเปิดบริการจริงยังต้องทดสอบ Google/Gmail กับ credentials จริง, ทดสอบ network/TLS ของ MariaDB, สำรองและกู้คืนข้อมูล/keys, load test และตรวจ security โดยผู้ดูแล deployment นี้ยังไม่ได้เชื่อมต่อ host จริงหรือ deploy ให้คุณ
