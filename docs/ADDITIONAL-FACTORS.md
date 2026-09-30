# Passkeys, LINE Number Matching และ Firebase Phone Authentication

คู่มือสำหรับ CUSA SSO บน `https://sso.reunion.scicu-alumni.com` รุ่น migration `006_additional_factors.sql` ทั้งสามช่องทางเพิ่มจาก Google, TOTP, Email OTP และ Recovery codes เดิม ไม่เปลี่ยน API contract ของ Service ที่เชื่อมผ่าน SSO

## เส้นทางใช้งานและนโยบาย

1. ผู้ใช้เข้าสู่ระบบด้วย Google ที่อยู่ใน Allowlist
2. บัญชีที่ยังไม่เปิด TOTP ใช้ Email OTP พร้อม Ref; บัญชีที่เปิด TOTP เลือก TOTP, Recovery code, Passkey หรือ LINE ที่ผูกไว้แล้วได้
3. การผูก/ถอด Passkey หรือ LINE ต้องมี TOTP และยืนยัน TOTP ภายใน 5 นาที ระบบแสดงหน้าต่างยืนยันใหม่เมื่อจำเป็น การเข้าสู่ระบบด้วย Recovery code ต้องตั้ง Authenticator ใหม่ก่อนจัดการวิธีสำรอง
4. Admin ที่ยืนยันด้วย Passkey/LINE ต้องกด **ยืนยันสิทธิ์ Admin** และกรอก TOTP ก่อนเปิดเมนูดูแลระบบ
5. Firebase SMS ใช้ยืนยันเบอร์ครั้งแรก ไม่ทำให้ session ผ่าน MFA และไม่เปิดให้ใช้เบอร์เป็นบัญชีหลักแทน Google หากเปิด `FIREBASE_PHONE_REQUIRED=true` จะบังคับเฉพาะบัญชีที่สร้างหลังเปิดนโยบายนี้ ทั้งหน้าเว็บและการออก/แลก/ตรวจ token ฝั่ง SSO ตรวจสถานะเบอร์
6. ปิด TOTP, ตั้ง TOTP ใหม่ หรืออนุมัติคำขอรีเซ็ต MFA จะถอน Passkeys และ LINE เดิม พร้อมยกเลิก challenge และ session ที่เกี่ยวข้อง เบอร์ที่ผ่านการตรวจแล้วเป็นข้อมูลแยก ไม่ใช้แทน MFA

Email OTP ไม่กลายเป็น fallback สำหรับบัญชี TOTP โดยอัตโนมัติ หากทั้ง TOTP/Passkey/LINE/Recovery ใช้ไม่ได้ ให้ใช้ขั้นตอน [ขอรีเซ็ตพร้อมหลักฐาน](MFA-RESET.md) ไม่ออก MFA bypass code

## ก่อนเปิดฟีเจอร์

- Backup ฐานข้อมูลด้วยขั้นตอนที่ Host รองรับ และยกเว้นหลักฐาน/กุญแจหลักฐานตามคู่มือเดิม
- ติดตั้ง dependencies จาก lockfile, build หรือใช้ release ZIP แล้วรัน `npm run db:migrate:production` ด้วยบัญชี migration
- เพิ่มสิทธิ์เฉพาะ 4 ตารางใหม่ตาม [runtime-grants.sql](../server/sql/runtime-grants.sql) แล้วเปลี่ยนกลับบัญชี runtime
- `.env` อยู่ที่ Application Root นอก Document Root สิทธิ์ 0600; ไม่ส่ง Secret ผ่านแชต, Git, URL หรือ frontend
- ตัวอย่างและ `.env` ในเครื่องเพิ่มชื่อช่องให้แล้ว แต่ยังปิด LINE/Firebase จนกว่าจะใส่ค่าจริงและทดสอบ ไม่เปลี่ยน Google/Gmail keys เดิม
- ตั้ง `db:cleanup` ทุกชั่วโมงเพื่อล้าง challenge หมดอายุและ credential ชั่วคราวตาม [คู่มือ HostAtom](HOSTATOM-RELEASE.md)

## Passkeys

ตั้ง `PASSKEY_ENABLED=true` และใช้ HTTPS `APP_ORIGIN` ที่คงที่ ระบบใช้ **hostname ของ APP_ORIGIN เป็น RP ID** โดยไม่รวม scheme/port เช่น `sso.reunion.scicu-alumni.com` และตรวจ origin เต็มตรงกันทุกครั้ง Localhost ใช้ทดสอบ WebAuthn ได้ แต่ Passkey ที่ผูกกับ localhost ใช้กับโดเมนจริงไม่ได้

หน้า **ความปลอดภัย → วิธียืนยันเพิ่มเติม → Passkeys** ตั้งชื่อแล้วกดเพิ่ม จากนั้นยืนยันด้วยอุปกรณ์ ระบบขอ User Verification เสมอ (เช่น PIN/biometric ตามอุปกรณ์) เก็บ public key, counter, credential ID, transports และ backup flag เท่านั้น ไม่ขอ attestation ที่ระบุรุ่นอุปกรณ์และไม่รับ biometric/template จากอุปกรณ์

จำกัด 10 Passkeys ต่อบัญชี; challenge 3 นาที ผูกกับ session/account และใช้ครั้งเดียว; ตรวจ origin, RP ID, signature, user verification, user handle และ counter การลบ Passkey ถอน session อื่นด้วย อุปกรณ์ที่ counter เป็น 0 หรือ sync ข้ามอุปกรณ์ยังต้องผ่านการตรวจของไลบรารี ไม่สรุปว่า counter พิสูจน์การโคลนได้ทุกกรณี

วิธีนี้เป็น **MFA หลัง Google** ไม่ใช่การเปิดสมัคร/เข้าสู่บัญชีใหม่ด้วย Passkey เพียงอย่างเดียว นโยบาย TOTP/Recovery หลักทำให้การกู้บัญชีและสิทธิ์ Admin ยังมีเส้นทางเดิมที่ตรวจสอบได้ ดู [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server)

## LINE Login + Messaging API

ใช้ช่องที่สร้างไว้แล้วได้ แต่ LINE Login และ Messaging API ต้องอยู่ใต้ **LINE Provider เดียวกัน** เพื่อให้ user ID ของทั้งสองช่องสอดคล้องกัน ไม่ใช่เพียงชื่อ Official Account เหมือนกัน

| ค่าใน `.env` | นำมาจากไหน |
| --- | --- |
| `LINE_LOGIN_CHANNEL_ID` | LINE Developers → LINE Login channel → Basic settings → Channel ID |
| `LINE_LOGIN_CHANNEL_SECRET` | LINE Login channel เดียวกัน → Channel secret |
| `LINE_MESSAGING_CHANNEL_SECRET` | Messaging API channel ของ OA → Basic settings → Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API channel → Messaging API → Channel access token; token ต้องไม่หมดอายุ/ถูกถอน |
| `LINE_MFA_ENABLED` | ใส่ค่าครบแล้วเปลี่ยนเป็น `true` และ Restart App |

ตั้งค่าผู้ให้บริการ:

1. LINE Login → Callback URL: `https://sso.reunion.scicu-alumni.com/api/auth/line/callback`
2. เชื่อม Official Account ที่ถูกต้องกับ LINE Login channel และเผยแพร่ channel ตามกลุ่มผู้ทดสอบ/ผู้ใช้จริงที่ต้องการ
3. Messaging API → Webhook URL: `https://sso.reunion.scicu-alumni.com/api/auth/line/webhook` เปิด Use webhook และ Webhook redelivery แล้วกด Verify
4. ตั้ง webhook ผ่าน HTTPS, proxy ต้องไม่แก้ raw JSON body; ไม่เปิด CORS หรือข้าม CSRF ให้ API อื่นเพื่อแก้ webhook
5. ผู้ใช้เพิ่มเพื่อน OA, เข้า CUSA SSO ด้วย Google/TOTP, หน้า **ความปลอดภัย → ผูกบัญชี LINE** จากนั้นยืนยัน LINE Login
6. ล็อกเอาต์และเข้าใหม่ เลือก **ยืนยันผ่าน LINE** หน้าเว็บจะแสดงเลข 2 หลัก ข้อความ LINE มีเลขให้เลือก 3 ค่าและปุ่มปฏิเสธ เลือกค่าให้ตรงกัน คำขอหมดอายุ 3 นาที

การป้องกัน: OAuth state/nonce/S256 PKCE ใช้ครั้งเดียวและผูกกับ session ที่ยืนยัน TOTP; backend แลกและตรวจ LINE ID token เอง ไม่เชื่อ `userId` ที่ browser ส่งมา; user ID เก็บเข้ารหัสพร้อม HMAC สำหรับ unique lookup; หนึ่ง LINE ผูกได้หนึ่งบัญชี

Webhook ตรวจ HMAC-SHA256 บน **raw body** ก่อนอ่าน JSON, รับ postback จาก user chat เท่านั้น, ตรวจผู้ส่ง/อายุ/challenge/choice token ที่สุ่ม ไม่รับแค่เลข 2 หลักเป็นหลักฐาน การตอบผิดหรือปฏิเสธทำให้คำขอนั้นจบทันที คำตอบซ้ำไม่ทำงานซ้ำ Webhook เพียงอนุมัติคำขอ ส่วน cookie/CSRF ของ browser เดิมใช้รับ session ใหม่และหมุน token

ขอใหม่อย่างน้อย 60 วินาที ตรวจใน MariaDB ระดับบัญชีแม้ reload/เปลี่ยน session และจำกัด 3 ครั้งต่อ 10 นาทีทั้ง user/IP; ส่งล้มเหลวก็ยังคง cooldown ไม่มี auto-push เมื่อเปิดหน้า MFA ผู้ใช้เป็นผู้กดขอเอง งบ/จำนวนข้อความ LINE ต้องตั้งและติดตามที่ผู้ให้บริการ Number Matching ไม่ได้มีความต้าน phishing เทียบเท่า WebAuthn

อ้างอิง: [LINE Login](https://developers.line.biz/en/docs/line-login/integrate-line-login/), [ตรวจ ID token](https://developers.line.biz/en/docs/line-login/verify-id-token/), [ตรวจ Webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)

## Firebase SMS

ใช้ **Firebase Authentication → Phone** ของ project ที่มีอยู่ได้ แนะนำ project ที่แยกสำหรับ CUSA เพื่อแยก quota และข้อมูลทดสอบ ไม่ใช้ Firebase custom token หรือ Google ID token จากขั้นตอน Google Login แทน Firebase Phone ID token

| ค่าใน `.env` | นำมาจากไหน / การเปิดเผย |
| --- | --- |
| `FIREBASE_PROJECT_ID` | Firebase → Project settings → General → Project ID |
| `FIREBASE_API_KEY` | Web app → SDK setup/config → apiKey; เป็น web config ที่ browser ต้องใช้ ไม่ใช่ server secret |
| `FIREBASE_AUTH_DOMAIN` | Web app config → authDomain เช่น `project-id.firebaseapp.com`; ใส่ hostname ไม่มี `https://` |
| `FIREBASE_APP_ID` | Web app config → appId |
| `FIREBASE_CLIENT_EMAIL` | service account ที่ใช้ตรวจ Firebase Authentication → `client_email`; เก็บเฉพาะ server |
| `FIREBASE_PRIVATE_KEY` | service account เดียวกัน → `private_key`; ใส่ค่าใน double quotes โดยแทน newline ด้วย `\n`; ห้ามอัปโหลด JSON ใต้ public |
| `FIREBASE_PHONE_ENABLED` | `true` เมื่อค่าครบและเปิด Phone provider แล้ว |
| `FIREBASE_PHONE_REQUIRED` | เริ่มด้วย `false`; `true` บังคับเฉพาะผู้ใช้ใหม่หลังเวลาที่เปิด ต้องผ่านการประเมินความจำเป็นก่อน |

ขั้นตอนใน Console:

1. เปิด Phone sign-in provider และ billing ที่จำเป็นสำหรับแผน/ภูมิภาคของ project
2. Authentication → Settings → Authorized domains เพิ่ม `sso.reunion.scicu-alumni.com` Google ระบุว่า localhost ไม่ใช่ hosted domain สำหรับ Phone Auth ให้ทดสอบส่งจริงบน HTTPS staging domain ที่อนุญาต
3. ตั้ง SMS region policy เฉพาะประเทศที่ใช้งานจริง (เช่น Thailand) ตรวจ quota, spending/budget alerts และการป้องกัน abuse ของ project อย่าเปิดทุกประเทศโดยไม่มีความจำเป็น การแจ้งเตือนงบอย่างเดียวไม่ได้หยุดค่าใช้จ่าย
4. service account ต้องตรวจ ID token และอ่านสถานะผู้ใช้ได้สำหรับ `verifyIdToken(token, true)` จำกัดสิทธิ์เท่าที่จำเป็น ไม่ให้ Owner ของ project เพื่อความสะดวก
5. ตั้ง test phone numbers เฉพาะ project ทดสอบและเอาออกจาก production: test number/code คงที่ถือเป็นหลักฐานที่ปลอมแทน SMS ได้ โค้ดแอปไม่เปิด `appVerificationDisabledForTesting` และไม่ยอมใช้ Auth emulator ใน production
6. Restart App, ไป **ความปลอดภัย → ยืนยันเบอร์มือถือ** อ่านประกาศ, ระบุ E.164 เช่น `+66812345678`, ยืนยันข้อความก่อนส่ง, ทำ reCAPTCHA, กรอก 6 หลัก ระบบตรวจ ID token ฝั่ง server แล้วบันทึกเบอร์เข้ารหัส

ผู้ใช้ใหม่ที่ต้องยืนยันเบอร์จะเห็นหน้าเฉพาะหลัง Google + MFA และก่อนเข้า console/Service เดิมไม่ถูกบังคับย้อนหลัง การปิด provider ในภายหลังไม่ได้ปลด `phone_required` ของบัญชีที่สร้างไปแล้วโดยอัตโนมัติ ต้องวางแผนช่วยเหลือผู้ใช้ค้างก่อนปิด

Backend ตรวจ Firebase signature/issuer/audience/expiry และ revoked/disabled state ผ่าน Admin SDK, ต้อง `sign_in_provider=phone`, `auth_time` ภายใน 3 นาทีและหลังเริ่ม challenge (เผื่อเวลา 10 วินาที) ไม่ยอมให้ refresh token เก่ามาทำเป็นยืนยัน SMS ใหม่; ผูก challenge กับ session และเบอร์ที่ร้องขอ, unique HMAC ของเบอร์/UID; จำกัด API 3 คำขอ/10 นาทีและ cooldown 60 วินาที เบอร์เดิมใช้ได้หนึ่งบัญชีในระบบ ณ ขณะนั้น แต่ไม่ใช่ “หนึ่งคนหนึ่งเบอร์” และต้องมีวิธีประสานกรณีเบอร์หมุนเวียน

**ขอบเขตของ cooldown:** Firebase SDK ส่ง SMS ไป Firebase โดยตรง ผู้เรียกอาจข้ามหน้า CUSA เพื่อเรียก Firebase API ได้ การจำกัดฝั่ง CUSA จึงไม่ใช่ hard cap ค่า SMS ต้องควบคุม region/quota/reCAPTCHA ที่ Firebase ด้วย โค้ดใช้ reCAPTCHA ของ Phone Auth SDK ไม่อ้างว่าเป็นการบังคับ reCAPTCHA v3 enterprise ทุก project

Firebase auth state อยู่ใน memory เท่านั้น; หลังยืนยัน/ออกจากหน้าเรียก signOut ไม่เก็บ Firebase token ใน localStorage ไม่มีการเก็บ SMS OTP ใน CUSA และข้อความ SMS ถูกกำหนดโดย Firebase ไม่ใช้ template ของ Email OTP

ประกาศความเป็นส่วนตัวรุ่น 1.2 ครอบคลุม provider และข้อมูลใหม่ การเริ่มยืนยันบันทึก purpose/version/acknowledgement ใน audit โดยไม่ใส่เบอร์หรือ ID token การถอน/ลบต้องประสานทั้ง CUSA และ Firebase; ไม่มีการลบ Firebase user ให้อัตโนมัติในรุ่นนี้

อ้างอิง: [Firebase Phone Auth](https://firebase.google.com/docs/auth/web/phone-auth), [Admin ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens), [Firebase limits](https://firebase.google.com/docs/auth/limits)

## API ของหน้า CUSA (ไม่ใช้เป็น Service API)

ทุก API ใต้ตารางต้องมี cookie ของเจ้าของบัญชี; POST/DELETE ต้องมี Origin ตรง APP_ORIGIN และ X-CSRF-Token ยกเว้น LINE webhook ที่ตรวจลายเซ็นผู้ให้บริการ Callback เป็น GET ที่มี state/nonce แยก

| Method + path ใต้ `/api/auth` | สิทธิ์ / payload |
| --- | --- |
| `GET /factors` | Full session; ส่งเฉพาะสถานะ, metadata Passkey และ public Firebase config |
| `POST /passkeys/register/options` | Full session + TOTP สด; `{}` → `{challengeId,options}` |
| `POST /passkeys/register/verify` | TOTP สด; `{challengeId,name,response}` → 201 |
| `DELETE /passkeys/:id` | TOTP สด; ลบของตัวเองและถอน session อื่น |
| `POST /passkeys/authenticate/options` | Pending Google session ที่มี TOTP และ Passkey |
| `POST /passkeys/authenticate/verify` | `{challengeId,response}` → หมุน cookie เมื่อผ่าน |
| `POST /line/link` | TOTP สด; `{}` → `{url}` ที่ backend สร้าง |
| `GET /line/callback` | OAuth code/state จาก LINE Login |
| `DELETE /line/link` | TOTP สด; ถอดของตัวเองและถอน session อื่น |
| `POST /line/send` | Pending session; `{}` → `{challengeId,number,expiresIn,retryAfter}` |
| `GET /line/challenges/:id` | Session เจ้าของ; `{status}` โดยไม่ส่ง choice token |
| `POST /line/verify` | Pending session; `{challengeId}` → หมุน cookie เมื่อ approved |
| `POST /line/webhook` | raw signed JSON จาก LINE; ไม่รับ browser cookie เป็นหลักฐานแทน signature |
| `POST /phone/start` | Full session; `{phone,acknowledged:true,noticeVersion:"1.2"}` |
| `POST /phone/verify` | Full session; `{challengeId,idToken}` จาก Firebase Phone Auth |

ข้อผิดพลาด: 400 validation/registration ผิด, 401 proof/session ไม่ถูกต้อง, 403 ต้องยืนยันใหม่/สิทธิ์ไม่ครบ, 404 ปิด provider, 409 ผูกซ้ำ/สถานะไม่พร้อม, 429 cooldown/rate limit พร้อม Retry-After, 503 provider/ระบบจำกัดคำขอไม่พร้อม ไม่มีการ return OTP/private key/LINE subject ให้ browser

## การยืนยันหลัง deploy

ใช้บัญชีทดสอบที่อนุญาตจริง: Google → TOTP → เพิ่ม Passkey → logout → Google → Passkey; ผูก LINE → logout → Google → Number Matching ถูก/ผิด/ปฏิเสธ; Firebase project ทดสอบ → reCAPTCHA → SMS → ตรวจเบอร์ยืนยันโดยไม่เปลี่ยนวิธี MFA; และ account ใหม่แบบ required ต้องถูกบล็อกก่อนยืนยัน

ตรวจ browser console CSP, proxy, provider quota, เวลา server, schema/runtime grants, LINE callback/webhook Verify และลองเลิกผูก/รีเซ็ต MFA ด้วยหลักฐานจำลอง ผล automated test ในเครื่องไม่แทนการทดสอบ provider จริงบน Host
