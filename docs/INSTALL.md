# ติดตั้ง CUSA SSO ครั้งแรกผ่าน /install

การอัปโหลดไฟล์ไม่ได้สร้างตารางอัตโนมัติ ให้สร้าง **Database และ Database User ใน Plesk** ก่อน แล้วเลือกติดตั้งผ่านเว็บตามคู่มือนี้ หรือใช้ `npm run db:migrate` และ `npm run db:bootstrap` ตามเดิม

จากภาพ HostAtom ฐานข้อมูล `scicualu_alumni` และผู้ใช้ `scicualu_re` มีอยู่แล้ว แต่ยังมี 0 ตาราง จึงไม่ต้องสร้าง Database ชื่อใหม่ เพียงให้ตัวติดตั้งสร้างตารางในฐานข้อมูลนี้ หน้านี้ใช้สำหรับติดตั้งครั้งแรกเท่านั้น ระบบเดิมให้อัปเดตผ่าน migration CLI

## 1. เตรียมแอปบน Plesk

- อัปโหลดโปรเจกต์รวม `server/migrations` ทั้งหมด ใช้ Application Root ที่มี `app.cjs` และ Document Root เป็น `public` ตาม [คู่มือ Plesk](PLESK.md)
- ติดตั้ง dependencies บน Host ด้วย `npm ci --include=dev` และ build ด้วย `npm run build` ก่อนเปิด `/install` ตัวติดตั้งผ่านเว็บทำหน้าที่สร้างตารางและผู้ดูแล ไม่ได้ติดตั้ง Node.js, npm packages หรือสร้างโดเมน/HTTPS
- ตั้ง DB, Google Login, Gmail OAuth และ encryption keys ใน Environment หรือ `.env` ให้ครบ Production ต้องใช้ HTTPS
- บัญชี DB ระหว่างติดตั้งต้องมีสิทธิ์สร้าง/ปรับตารางและดัชนี รวมถึงอ่าน/เขียนข้อมูลเริ่มต้น เมื่อเสร็จให้กลับไปใช้สิทธิ์ runtime ตาม [คู่มือ Audit](AUDIT-OPERATIONS.md) ตัวติดตั้งไม่สั่ง CREATE USER/GRANT ให้ผู้ใช้เอง

ตัวอย่างเฉพาะค่าบน HostAtom (รหัสผ่านใช้ค่าจริงเดิมของคุณ):

```dotenv
NODE_ENV=production
APP_ORIGIN=https://sso.reunion.scicu-alumni.com
DB_HOST=localhost
DB_PORT=3306
DB_NAME=scicualu_alumni
DB_USER=scicualu_re
DB_TLS=false
DB_CA_FILE=
BOOTSTRAP_ADMIN_EMAIL=อีเมลบัญชี-Google-ของผู้ดูแล
INSTALL_ENABLED=true
INSTALL_TOKEN=รหัสสุ่ม-base64url-43-ตัวอักษร
```

ตัวอย่างอีเมลและ token ต้องแทนด้วยค่าจริงก่อนใช้ `DB_HOST=localhost` ใช้บน Host ที่ฐานข้อมูลอยู่เครื่องเดียวกัน ไม่ใช่เครื่องพัฒนาของคุณ ค่า Environment ใน Plesk มีลำดับความสำคัญเหนือ `.env` หากตั้งซ้ำ ให้แก้ในตำแหน่งที่ process ใช้จริง

สร้าง INSTALL_TOKEN ใหม่ด้วย CSPRNG 32 bytes:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

เก็บ token ใน Environment ฝั่งเซิร์ฟเวอร์และใช้กรอกในหน้า `/install` อย่าใส่ใน URL, `VITE_*`, Git หรือส่งให้ผู้ใช้ทั่วไป ตัวติดตั้งปิดไว้เป็นค่าเริ่มต้น ไม่มี default password และจะไม่เริ่มในโหมดติดตั้งหาก token/email รูปแบบไม่ถูกต้อง

## 2. ติดตั้งผ่านเว็บ

1. กด **Restart App** ใน Plesk เพื่ออ่าน Environment ใหม่ ช่วง `INSTALL_ENABLED=true` API สำหรับ Login/Admin/SSO และ Audit Worker จะพักไว้ `/api/ready` คืน 503 จนปิดโหมดนี้
2. เปิด `https://sso.reunion.scicu-alumni.com/install` กรอกรหัสติดตั้ง แล้วกด **ตรวจสอบความพร้อม**
3. ตรวจชื่อ DB, Host และอีเมลผู้ดูแลที่แสดง หน้าเว็บอ่านค่าจากเซิร์ฟเวอร์ ไม่รับ DB credentials หรืออีเมลผู้ดูแลใหม่จากคำขอของเบราว์เซอร์
4. ติ๊กยืนยัน แล้วกด **สร้างตารางและติดตั้งระบบ** รอจนแสดงว่าสำเร็จ

การตรวจความพร้อมเช็กการเชื่อมต่อ/เวอร์ชัน MariaDB, UTC, สถานะฐานข้อมูล, ความครบของ config และ Redis PING หากตั้งค่าไว้ โดยยังไม่เขียนตารางหรือส่งอีเมล การทดสอบนี้ไม่ยืนยันสิทธิ์ DDL ล่วงหน้าหรือยืนยันว่า Google/Gmail credentials ใช้งานได้จริง ต้องทดสอบ Login + OTP หลังเปิดใช้งาน

ตัวติดตั้งเรียก migrations ชุดเดียวกับ CLI และเพิ่มอีเมลผู้ดูแลลง allowlist บัญชี user และชื่อจาก Google จะเกิดเมื่อเข้าสู่ระบบจริงครั้งแรก ไม่มีรหัสผ่านบัญชีเริ่มต้นและไม่ข้าม MFA

## 3. ปิดตัวติดตั้ง

หลังเห็นว่าสำเร็จ ให้แก้ค่าบน Host:

```dotenv
INSTALL_ENABLED=false
INSTALL_TOKEN=
```

เปลี่ยนกลับเป็นบัญชี DB สำหรับ runtime หากแยกบัญชีไว้ แล้วกด **Restart App** อีกครั้ง `/install` และ `/api/install/*` จะคืน 404 ตรวจ `/api/ready` ให้ได้ 200 แล้วทดสอบ Google Login และ OTP

**ไม่ต้องลบโฟลเดอร์ install** เพราะระบบนี้เป็น route ใน Express/React ไม่ใช่ไฟล์ PHP แยก และการปิดอยู่ฝั่งเซิร์ฟเวอร์ นอกจากนี้ marker ใน `installation_state` จะห้ามติดตั้งซ้ำแม้เผลอเปิด `INSTALL_ENABLED=true` อีกครั้ง อย่าลบตารางหรือ marker นี้เพื่อพยายามติดตั้งซ้ำ อย่าลบไฟล์ migrations เพราะจำเป็นสำหรับตรวจ checksum และอัปเดตในอนาคต

## ติดตั้งค้างหรือเกิดข้อผิดพลาด

- **404:** ตรวจ `INSTALL_ENABLED` และ Restart App; หากตั้งค่าครบแล้วให้ตรวจ Document Root/Passenger
- **401:** รหัสติดตั้งไม่ตรง Environment ของ process
- **403:** เปิดหน้าจาก origin เดียวกับ `APP_ORIGIN` และใช้ HTTPS จริงใน Production
- **409 INSTALL_BUSY:** มีการติดตั้งหรือ migration อีก process ทำงาน รอแล้วตรวจใหม่
- **409 INSTALL_LOCKED:** ติดตั้งเสร็จแล้ว หรือพบข้อมูลผู้ใช้/สิทธิ์/บริการ/Audit เดิม ให้ปิดโหมดติดตั้ง หากเป็นระบบเดิมให้อัปเดตผ่าน CLI ไม่ใช้ตัวติดตั้งสร้าง admin ใหม่
- **429:** ลองรหัสหรือส่งคำขอล้มเหลวเกิน 10 ครั้งต่อ IP ต่อ process ใน 15 นาที ให้รอเวลา; ติดตั้งจากเครือข่ายผู้ดูแลและคง rate limit ของ reverse proxy ไว้หากมี
- **503 INSTALL_FAILED:** ตรวจ DB credentials, network, สิทธิ์ DDL/ข้อมูล, โฟลเดอร์ migrations และ Redis โค้ดไม่เปิดเผยรหัสผ่าน/SQL driver error ให้หน้าเว็บ หากต้องแยกสาเหตุให้รัน migration CLI ใน Terminal บน Host

MariaDB ทำ implicit commit สำหรับ DDL จึงไม่อ้างว่าการสร้างตารางทั้งหมด rollback ได้ หาก process หยุดกลาง migration สามารถแก้สาเหตุแล้วกดติดตั้งใหม่บนฐานข้อมูลว่างเดิมได้: DDL ปัจจุบันใช้ IF NOT EXISTS และเก็บ checksum เมื่อแต่ละไฟล์สำเร็จแล้ว ส่วนการเพิ่ม admin, Audit ของ bootstrap และ marker สุดท้ายอยู่ใน transaction เดียวกัน

GET_LOCK ล็อกตลอดการติดตั้งด้วย connection เดียว ป้องกัน migration/installer/CLI bootstrap หลาย process ชนกัน และแยกจาก transaction ตาม [เอกสาร MariaDB GET_LOCK](https://mariadb.com/docs/server/reference/sql-functions/secondary-functions/miscellaneous-functions/get_lock) และ [DDL implicit commits](https://mariadb.com/docs/server/reference/sql-statements/transactions/sql-statements-that-cause-an-implicit-commit)

หากคำขอขาดการเชื่อมต่อหลัง commit ไปแล้ว การตรวจครั้งถัดไปจะพบ INSTALL_LOCKED ให้ตรวจผู้ดูแลใน DB แล้วปิดโหมดติดตั้ง ไม่ลบข้อมูลเพื่อเริ่มใหม่ ตั้งค่า timeout ของ reverse proxy ให้เหมาะกับการสร้างตารางตามขนาดและโหลดของ Host
