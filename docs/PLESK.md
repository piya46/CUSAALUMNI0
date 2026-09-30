# Deploy CUSA SSO บน Plesk

คู่มือนี้สำหรับ **Plesk บน Linux ที่เปิด Node.js/Passenger** ใช้โดเมนเดียวสำหรับหน้าเว็บและ API สมมติชื่อโดเมน `sso.example.com` และโฟลเดอร์โปรเจกต์ `cusa-sso` ภายใน webspace ของบัญชี hosting

หากใช้โดเมน `sso.reunion.scicu-alumni.com` และอัปเดตรุ่นนี้ ดู [ขั้นตอน Upload ZIP และ Scheduled Tasks บน HostAtom](HOSTATOM-RELEASE.md) มี `deploy:package`, `deploy:check` และคำสั่ง migration ที่ใช้ production build ได้โดยไม่ต้องมี tsx บน Host

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

### ฐานข้อมูลภายใน HostAtom / Plesk

หาก Node.js และ MariaDB อยู่บนเครื่องเดียวกัน และ Plesk → Databases ระบุ Database server เป็น `localhost:3306` ให้ตั้งค่าบน **Host ที่ Deploy** ดังนี้:

```dotenv
NODE_ENV=production
APP_ORIGIN=https://sso.reunion.scicu-alumni.com
DB_HOST=localhost
DB_PORT=3306
DB_TLS=false
DB_CA_FILE=
```

ภาพ Connection information ที่ผู้ใช้ส่งมาระบุ `localhost:3306` ให้แยก host และ port ตามตัวอย่างข้างต้น ค่านี้ใช้กับแอปที่อยู่ใน network namespace เดียวกับฐานข้อมูลและรับ TCP loopback จริง หากต้องระบุ IPv4 ชัดเจนให้ใช้ `127.0.0.1`; หาก listener ใช้ IPv6 ให้ใช้ `::1` ตามที่ Host แจ้ง [คู่มือ HostAtom](https://kb.hostatom.com/content/1024/) อธิบายว่า Database Host ใช้ localhost เมื่ออยู่เครื่องเดียวกัน

หากฐานข้อมูลอยู่อีกเครื่องในเครือข่ายภายใน ให้ใช้ Private IP ที่ Host แจ้งแทน `127.0.0.1` Production อนุญาต `DB_TLS=false` เฉพาะ `localhost`, loopback IPv4/IPv6, IPv4 ช่วง `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` และ IPv6 ULA `fc00::/7` การระบุ Private IP ไม่ได้เข้ารหัสข้อมูลหรือยืนยันว่าเครือข่ายถูกแยกจากลูกค้ารายอื่น ผู้ดูแลต้องตรวจเส้นทางและการจำกัดการเข้าถึงตามสภาพแวดล้อมจริง

ชื่อผู้ให้บริการเดียวกันหรือชื่อ DNS ที่มีคำว่า internal ไม่ใช่หลักฐานของเส้นทางภายใน โค้ดไม่อนุมาน IP ภายในจาก hostname ทั่วไป หาก Host ให้ hostname ภายในมา ให้ขอ endpoint ที่เหมาะสม/Private IP จาก Host หรือใช้ TLS ที่ตรวจสอบใบรับรองได้ สำหรับ IP สาธารณะ เช่น `203.170.190.137` โหมด Production ยังต้องใช้ `DB_TLS=true`

อย่าเปลี่ยน `DB_HOST` บนเครื่องพัฒนาเป็น `127.0.0.1` เพื่อชี้ไปที่ HostAtom เพราะจะหมายถึงฐานข้อมูลบนเครื่องพัฒนาของคุณเอง ค่าทดสอบจากเครื่องพัฒนาและค่าบน Host ต้องแยกกัน การปิด DB TLS ไม่เปลี่ยนข้อกำหนด HTTPS ของเว็บ, Secure cookie หรือ TLS ของ Upstash Redis

`SSO_DOMAIN` ใช้สำหรับ Caddy ใน Docker Compose เท่านั้น ไม่จำเป็นในวิธี Plesk นี้ ส่วน `PORT` ไม่ใช่พอร์ตที่ต้องเปิดรับจากอินเทอร์เน็ต เพราะ [Passenger จัดการ socket และรับคำขอให้ Node.js](https://www.phusionpassenger.com/library/indepth/nodejs/reverse_port_binding.html)

`REDIS_URL` เว้นว่างได้เพื่อใช้ MariaDB สำหรับตัวนับ Rate Limit หากใช้ Upstash ให้สร้าง/เลือก Redis Database แล้วคัดลอก **Connect → TCP** URL แบบ `rediss://default:PASSWORD@HOST:PORT` มาใส่ที่นี่ ไม่ใช้ HTTPS REST URL และต้องอนุญาต TCP ขาออกจาก Host ไปยัง endpoint/port ของ Upstash จากนั้น Restart App ดู [ขั้นตอน Redis](../README.md#redis-และ-upstash)

หลัง deploy ตรวจว่า `/privacy` และ `/terms` เปิดได้โดยไม่ล็อกอิน และใช้ URL จริงของสองหน้านี้เมื่อตั้งค่า Privacy Policy/Terms of Service ใน Google OAuth consent screen ทบทวนรายละเอียดองค์กรและการปฏิบัติงานตาม [คู่มือเอกสารนโยบาย](LEGAL.md) ก่อนประกาศใช้

ตรวจ `TRUST_PROXY` กับผู้ดูแล Host ตาม proxy chain จริง หาก proxy ส่ง IP ผู้ใช้ใน forwarded headers ต้องตั้งให้ Express เชื่อถือเฉพาะ proxy ที่ควบคุมได้ เพื่อให้ rate limit และ Audit บันทึก IP ถูกต้อง ค่าของ Docker Compose ไม่ใช่ข้อกำหนดของ Plesk

สำหรับติดตั้งครั้งแรกบนฐานข้อมูลว่าง ใช้หน้า **`/install`** ได้ตาม [คู่มือติดตั้งผ่านเว็บ](INSTALL.md): เปิด `INSTALL_ENABLED=true`, ตั้ง `INSTALL_TOKEN` และ `BOOTSTRAP_ADMIN_EMAIL`, Restart App แล้วดำเนินการในหน้าเว็บ เมื่อเสร็จปิด flag/ล้าง token และ Restart App อีกครั้ง ไม่ต้องลบโฟลเดอร์ ตัวติดตั้งสร้างตารางและผู้ดูแลเท่านั้น; ต้องสร้าง Database ใน Plesk และ build แอปก่อน

หากเลือกใช้ Terminal แทนหน้าเว็บ หรือเป็นการอัปเดตระบบเดิม ให้รันด้วยบัญชี migration ที่มีสิทธิ์ DDL และ runtime account ที่เหมาะสมตาม README:

```sh
npm run db:migrate
# เฉพาะติดตั้งครั้งแรก ตั้ง BOOTSTRAP_ADMIN_EMAIL ก่อนรัน:
npm run db:bootstrap
```

สำหรับระบบเดิมต้องรัน migrations ที่ยังไม่มีให้ครบถึง `005_mfa_reset_evidence.sql` ก่อนใช้ Backend รุ่นนี้ และ Admin ต้องกำหนดสมาชิก/Role ของแต่ละ Service ตาม [คู่มือ Service Access](SERVICE-ACCESS.md)

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
