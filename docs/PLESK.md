# Deploy CUSA SSO บน Plesk

คู่มือนี้สำหรับ **Plesk บน Linux ที่เปิด Node.js/Passenger** ใช้โดเมนเดียวสำหรับหน้าเว็บและ API สมมติชื่อโดเมน `sso.example.com` และโฟลเดอร์โปรเจกต์ `cusa-sso` ภายใน webspace ของบัญชี hosting

## ค่าที่ใส่ในหน้า Node.js

| ช่องใน Plesk | ค่า |
| --- | --- |
| Node.js Version | Node.js 22 รุ่นอัปเดตล่าสุดที่ Host มี และอย่างน้อย 22.12 |
| Application Mode | Production |
| Application Root | `/cusa-sso` |
| Document Root | `/cusa-sso/public` |
| Application Startup File | `app.cjs` |
| Application URL | `https://sso.example.com` |

เส้นทาง `/cusa-sso` ในตารางเป็นเส้นทางที่เลือกใน File Manager ของ webspace ไม่ใช่การสร้างโฟลเดอร์ที่ root ของ Linux ตัวอย่างตำแหน่งจริงอาจเป็น `/var/www/vhosts/example.com/cusa-sso` ให้เลือกโฟลเดอร์เดียวกับ `package.json` และ `app.cjs`

Plesk แยก Application Root ออกจาก Document Root และต้องเลือกไฟล์เริ่มต้นของแอปให้ตรง ตาม [คู่มือ Node.js ของ Plesk](https://doc.plesk.com/en-US/obsidian/administrator-guide/website-management/hosting-nodejs-applications.76652/)

`app.cjs` ใช้ CommonJS โหลด `server/dist/index.js` ด้วย dynamic import เพื่อรองรับตัวโหลดของ Passenger ตาม [วิธีรองรับ ESM ที่ Plesk แนะนำ](https://support.plesk.com/hc/en-us/articles/12389037025431-A-Node-js-app-hosted-in-Plesk-is-not-working-require-of-ES-Module-is-not-supported) และตรวจว่ามี build output ของทั้ง Backend/React ก่อนเริ่มแอป

## Document Root ใช้ public ว่าง

คง `public` ให้มีเพียง `.gitkeep` ไม่มี `index.html` เพื่อให้คำขอถูกส่งเข้า Node.js แล้ว Express ส่ง React จาก `web/dist` ทั้งหน้า `/`, `/login`, assets และ `/api/...` จึงผ่าน middleware และ Security Headers ของแอป

การเลือก `web/dist` เป็น Document Root ทำให้ web server อาจส่ง `index.html` โดยไม่ผ่าน Helmet ของ Express คู่มือนี้จึงปรับจากการเสิร์ฟ static โดยตรงเป็นส่งผ่าน Node.js สำหรับ Plesk

```text
cusa-sso/                 ← Application Root
  app.cjs                 ← Application Startup File
  package.json
  package-lock.json
  .env
  public/                 ← Document Root; ไม่มี index.html
    .gitkeep
  server/
    package.json
    migrations/
    src/
    dist/index.js
  web/
    package.json
    src/
    dist/index.html
```

วางโฟลเดอร์โปรเจกต์นอก Document Root ของเว็บไซต์อื่นด้วย อย่านำ `.env`, `server` หรือทั้งโปรเจกต์ไปเปิดเป็นไฟล์สาธารณะ หากอัปโหลดผ่าน ZIP ให้สร้าง `public` เองเมื่อเครื่องมือไม่เก็บโฟลเดอร์ที่มีเฉพาะไฟล์ซ่อน

## ติดตั้งและ Build

1. เปิด Node.js support สำหรับโดเมนใน Plesk ตั้ง DNS และ HTTPS ของ `sso.example.com` ให้พร้อม
2. อัปโหลด source และ lockfile ทั้งโปรเจกต์ รวม `server`, `web`, `app.cjs`, `public`; ติดตั้ง dependencies บน Host ไม่อัปโหลด `node_modules` จาก macOS เพราะมี native module ของ Argon2
3. ใช้ Node/npm รุ่นที่เลือกใน Plesk เปิด Terminal/SSH แล้วเข้า Application Root ตรวจ `node --version` ว่าตรง จากนั้นรัน:

```sh
npm ci --include=dev
npm run build
```

`--include=dev` ทำให้มี TypeScript และ Vite สำหรับ build แม้ Plesk ตั้ง Production อยู่ ไม่ใช้ `npm run dev` บน Host

## Environment และฐานข้อมูล

ตั้งตัวแปรใน Plesk Custom Environment Variables หรือ `.env` ที่ Application Root; environment ของ process มีลำดับความสำคัญเหนือ `.env` ถ้าตั้งซ้ำต้องปรับให้ตรงกัน

```dotenv
NODE_ENV=production
APP_ORIGIN=https://sso.example.com
DB_TLS=true
DB_CA_FILE=
```

เติม DB/Google/Gmail credentials และ encryption keys ให้ครบตาม `.env.example` คง `.env` ในเครื่องพัฒนาเป็น `http://localhost:5173`; ใช้ค่าของ production บน Host แยกกัน ไม่สร้าง encryption keys ใหม่ทับระบบที่มีข้อมูลเข้ารหัสอยู่แล้ว

`DB_CA_FILE` ว่างได้เมื่อใบรับรอง DB ตรวจสอบกับ trusted CA ของ Node.js ได้ หากใช้ private CA ให้ขอไฟล์จากผู้ดูแล DB และระบุ path ที่อ่านได้ ต้องตรวจสอบชื่อ Host ของ certificate ให้ตรงด้วย

`SSO_DOMAIN` ใช้สำหรับ Caddy ใน Docker Compose เท่านั้น ไม่จำเป็นในวิธี Plesk นี้ ส่วน `PORT` ไม่ใช่พอร์ตที่ต้องเปิดรับจากอินเทอร์เน็ต เพราะ [Passenger จัดการ socket และรับคำขอให้ Node.js](https://www.phusionpassenger.com/library/indepth/nodejs/reverse_port_binding.html)

ตรวจ `TRUST_PROXY` กับผู้ดูแล Host ตาม proxy chain จริง หาก proxy ส่ง IP ผู้ใช้ใน forwarded headers ต้องตั้งให้ Express เชื่อถือเฉพาะ proxy ที่ควบคุมได้ เพื่อให้ rate limit และ Audit บันทึก IP ถูกต้อง ค่าของ Docker Compose ไม่ใช่ข้อกำหนดของ Plesk

ก่อนเปิดแอป ให้รันด้วยบัญชี migration ที่มีสิทธิ์ DDL และ runtime account ที่เหมาะสมตาม README:

```sh
npm run db:migrate
# เฉพาะติดตั้งครั้งแรก ตั้ง BOOTSTRAP_ADMIN_EMAIL ก่อนรัน:
npm run db:bootstrap
```

สำหรับระบบเดิม migration `002_service_roles.sql` ต้องเสร็จก่อนใช้ Backend รุ่นนี้ และ Admin ต้องกำหนดสมาชิก/Role ของแต่ละ Service ตาม [คู่มือ Service Access](SERVICE-ACCESS.md)

## เริ่มแอปและตรวจหลัง Deploy

เลือก `app.cjs` เป็น Application Startup File แล้วกด **Enable Node.js / Restart App** ใน Plesk ใช้ Passenger จัดการ process; ไม่ต้องเปิด `npm start` หรือ PM2 ซ้อนสำหรับแอปเดียวกัน และไม่ต้องติดตั้ง Caddy เพื่อทับเว็บเซิร์ฟเวอร์ของ Plesk

ลงทะเบียน Google OAuth Authorized Redirect URI ของ production เป็น:

```text
https://sso.example.com/api/auth/google/callback
```

ตรวจผ่าน HTTPS ของโดเมนจริง:

- `/login` แสดง CUSA SSO และ refresh หน้าได้
- `/api/health` คืน JSON; `/api/ready` ต้องคืน HTTP 200 หลัง DB/Rate limiter/Audit worker พร้อม
- `/login` ต้องมี `Content-Security-Policy` ที่มี `frame-ancestors 'none'` และ `Referrer-Policy: no-referrer`; ถ้าไม่ได้รับ ให้ตรวจว่าไม่ได้เสิร์ฟ `index.html` จาก Document Root อื่นหรือ cache เก่า
- Google Login → MFA → Service callback ทำงาน และ Cookie มี `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`
- IP ใน Audit ตรงกับเครื่องผู้ใช้ ไม่ใช่ IP proxy หรือ header ที่ปลอมจากภายนอกได้

หาก `/api/health` ได้ HTML ให้ตรวจ Document Root, Startup File และการเปิด Node.js/Passenger; หากเริ่มแอปไม่สำเร็จให้ดู **Logs** ของโดเมน ตรวจ build output และ production environment โค้ดจะไม่พิมพ์ credentials ลง log เพื่ออธิบาย error

Passenger อาจหยุด process ที่ว่าง ทำให้ Audit Outbox worker หยุดระหว่างนั้นได้ ข้อมูล Outbox ยังคงอยู่ แต่การส่ง log จะรอ process กลับมาทำงาน ถ้าต้องให้ worker ทำงานต่อเนื่องให้ผู้ดูแลกำหนด process ขั้นต่ำ/อายุ idle ของ Passenger หรือจัด worker process แยกตามนโยบาย Host

การเตรียมไฟล์และทดสอบในเครื่องไม่ได้ยืนยันว่า Plesk/Passenger บน Host จริงตั้งค่าครบ ยังต้องตรวจตามขั้นตอนหลัง deploy นี้
