# Passkeys, LINE Number Matching และ Firebase Phone Authentication

คู่มือสำหรับ CUSA SSO บน `https://sso.reunion.scicu-alumni.com` รุ่น migration `006_additional_factors.sql` ทั้งสามช่องทางเพิ่มจาก Google, TOTP, Email OTP และ Recovery codes เดิม ไม่เปลี่ยน API contract ของ Service ที่เชื่อมผ่าน SSO

## เส้นทางใช้งานและนโยบาย

1. ผู้ใช้เข้าสู่ระบบด้วย Google ที่อยู่ใน Allowlist
2. บัญชีที่ยังไม่เปิด TOTP ใช้ Email OTP พร้อม Ref; บัญชีที่เปิด TOTP เลือก TOTP, Recovery code, Passkey หรือ LINE ที่ผูกไว้แล้วได้
3. การผูก/ถอด Passkey หรือ LINE ต้องตั้งค่า TOTP ไว้แล้ว และยืนยัน TOTP หรือ Passkey ภายใน 5 นาที ระบบแสดงหน้าต่างยืนยันใหม่เมื่อจำเป็น การเข้าสู่ระบบด้วย Recovery code ต้องตั้ง Authenticator ใหม่ก่อนจัดการวิธีสำรอง
4. Admin เลือกวิธีที่บัญชีใช้ได้ทั้งหมดเหมือนผู้ใช้ทั่วไป หน้า MFA แบ่งเป็น **วิธีแนะนำ** (Passkey/Authenticator), **วิธีอื่นที่ใช้ได้** (LINE หรือ Email OTP ตามนโยบายบัญชี) และ **กู้คืนบัญชี** (Recovery code/ขอรีเซ็ต) หากเลือก **Passkey หรือ Authenticator (TOTP)** ยืนยันตอนล็อกอินครั้งเดียวก็เปิดหน้าผู้ดูแลได้ ไม่ถามซ้ำเมื่อเปิดอ่านหน้าทั่วไป การเปลี่ยนสิทธิ์/ออกคีย์/เปิดหลักฐานต้องมีผลยืนยันจากสองวิธีนี้ภายใน 5 นาที ถ้ายังสดใช้ผลเดิม; ถ้าหมดช่วงเวลาจะแสดงหน้าต่างให้เลือก Passkey หรือ TOTP อีกครั้ง เซสชันที่เข้าโดย LINE ต้องยืนยันหนึ่งในสองวิธีนี้เพื่อเปิดสิทธิ์ Admin; Email, LINE, SMS และ Recovery ไม่ให้สิทธิ์ Admin โดยอัตโนมัติ
5. Firebase SMS ใช้ยืนยันเบอร์ครั้งแรก ไม่ทำให้ session ผ่าน MFA และไม่เปิดให้ใช้เบอร์เป็นบัญชีหลักแทน Google หากเปิด `FIREBASE_PHONE_REQUIRED=true` จะบังคับเฉพาะบัญชีที่สร้างหลังเปิดนโยบายนี้ ทั้งหน้าเว็บและการออก/แลก/ตรวจ token ฝั่ง SSO ตรวจสถานะเบอร์
6. ปิด TOTP, ตั้ง TOTP ใหม่ หรืออนุมัติคำขอรีเซ็ต MFA จะถอน Passkeys และ LINE เดิม พร้อมยกเลิก challenge และ session ที่เกี่ยวข้อง เบอร์ที่ผ่านการตรวจแล้วเป็นข้อมูลแยก ไม่ใช้แทน MFA

Email OTP ไม่กลายเป็น fallback สำหรับบัญชี TOTP โดยอัตโนมัติ หากทั้ง TOTP/Passkey/LINE/Recovery ใช้ไม่ได้ ให้ใช้ขั้นตอน [ขอรีเซ็ตพร้อมหลักฐาน](MFA-RESET.md) ไม่ออก MFA bypass code

## ก่อนเปิดฟีเจอร์

- Backup ฐานข้อมูลด้วยขั้นตอนที่ Host รองรับ และยกเว้นหลักฐาน/กุญแจหลักฐานตามคู่มือเดิม
- ติดตั้ง dependencies จาก lockfile, build หรือใช้ release ZIP แล้วรัน `npm run db:migrate:production` ด้วยบัญชี migration
- เพิ่มสิทธิ์เฉพาะ 4 ตารางใหม่ตาม [runtime-grants.sql](../server/sql/runtime-grants.sql) แล้วเปลี่ยนกลับบัญชี runtime
- `.env` อยู่ที่ Application Root นอก Document Root สิทธิ์ 0600; ไม่ส่ง Secret ผ่านแชต, Git, URL หรือ frontend
- ตัวอย่างและ `.env` ในเครื่องเพิ่มชื่อช่องให้แล้ว แต่ยังปิด LINE/Firebase จนกว่าจะใส่ค่าจริงและทดสอบ ไม่เปลี่ยน Google/Gmail keys เดิม
- ตั้ง `BACKGROUND_JOBS_ENABLED=true` ให้ Node ล้าง challenge/credential หมดอายุทุกชั่วโมง พร้อมงานลบหลักฐานและตรวจสุขภาพตาม [คู่มือ HostAtom](HOSTATOM-RELEASE.md); `db:cleanup` ยังใช้รันมือได้

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
| `LINE_WEBHOOK_DESTINATION` | แนะนำให้กำหนด bot `userId` ของ OA (`U` + hex ตัวเล็ก 32 ตัว); อ่านได้จาก `GET /v2/bot/info` ไม่ใช่ Channel ID หรือ `@basicId` |
| `LINE_WEBHOOK_GATEWAY_TOKEN` | ทางเลือกสำหรับ Central → SSO: token สุ่ม 32 bytes แบบ base64url ยาว 43 ตัว ต้องตั้ง `LINE_WEBHOOK_DESTINATION` ด้วย |
| `LINE_MFA_ENABLED` | ใส่ค่าครบแล้วเปลี่ยนเป็น `true` และ Restart App |

ตั้งค่าผู้ให้บริการ:

1. LINE Login → Callback URL: `https://sso.reunion.scicu-alumni.com/api/auth/line/callback`
2. เชื่อม Official Account ที่ถูกต้องกับ LINE Login channel และเผยแพร่ channel ตามกลุ่มผู้ทดสอบ/ผู้ใช้จริงที่ต้องการ
3. Messaging API → Webhook URL: `https://sso.reunion.scicu-alumni.com/api/auth/line/webhook` เมื่อรับตรงจาก LINE หรือ URL ของ Central เมื่อใช้วิธีด้านล่าง เปิด Use webhook และ Webhook redelivery แล้วกด Verify
4. ตั้ง webhook ผ่าน HTTPS, proxy ต้องไม่แก้ raw JSON body; ไม่เปิด CORS หรือข้าม CSRF ให้ API อื่นเพื่อแก้ webhook
5. ผู้ใช้เพิ่มเพื่อน OA, เข้า CUSA SSO ด้วย Google ตามด้วย TOTP หรือ Passkey, หน้า **ความปลอดภัย → ผูกบัญชี LINE** จากนั้นยืนยัน LINE Login
6. ล็อกเอาต์และเข้าใหม่ เลือก **ยืนยันผ่าน LINE** หน้าเว็บจะแสดงเลข 2 หลัก ข้อความ LINE มีเลขให้เลือก 3 ค่าและปุ่มปฏิเสธ เลือกค่าให้ตรงกัน คำขอหมดอายุ 3 นาที

การป้องกัน: OAuth state/nonce/S256 PKCE ใช้ครั้งเดียวและผูกกับ session ที่ยืนยัน TOTP หรือ Passkey ภายใน 5 นาที; backend แลกและตรวจ LINE ID token เอง ไม่เชื่อ `userId` ที่ browser ส่งมา; user ID เก็บเข้ารหัสพร้อม HMAC สำหรับ unique lookup; หนึ่ง LINE ผูกได้หนึ่งบัญชี

Webhook ตรวจ HMAC-SHA256 บน **raw body** ก่อนอ่าน JSON, รับ postback จาก user chat เท่านั้น, ตรวจผู้ส่ง/อายุ/challenge/choice token ที่สุ่ม ไม่รับแค่เลข 2 หลักเป็นหลักฐาน การตอบผิดหรือปฏิเสธทำให้คำขอนั้นจบทันที คำตอบซ้ำไม่ทำงานซ้ำ Webhook เพียงอนุมัติคำขอ ส่วน cookie/CSRF ของ browser เดิมใช้รับ session ใหม่และหมุน token

ขอใหม่อย่างน้อย 60 วินาที ตรวจใน MariaDB ระดับบัญชีแม้ reload/เปลี่ยน session และจำกัด 3 ครั้งต่อ 10 นาทีทั้ง user/IP; ส่งล้มเหลวก็ยังคง cooldown ไม่มี auto-push เมื่อเปิดหน้า MFA ผู้ใช้เป็นผู้กดขอเอง งบ/จำนวนข้อความ LINE ต้องตั้งและติดตามที่ผู้ให้บริการ Number Matching ไม่ได้มีความต้าน phishing เทียบเท่า WebAuthn

อ้างอิง: [LINE Login](https://developers.line.biz/en/docs/line-login/integrate-line-login/), [ตรวจ ID token](https://developers.line.biz/en/docs/line-login/verify-id-token/), [ตรวจ Webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)

### Central webhook: ส่ง raw body และลายเซ็น LINE เดิม

เส้นทางที่รองรับคือ `LINE → Central → POST /api/auth/line/webhook` ผ่าน HTTPS โดย SSO ตรวจ `X-Line-Signature` ด้วย `LINE_MESSAGING_CHANNEL_SECRET` ของ OA เองทุกครั้ง Central ต้องเก็บ raw bytes ก่อน JSON parser และตรวจลายเซ็นก่อน routing ห้ามตัด `events`, stringify ใหม่, เติม field, เปลี่ยน timestamp หรือเซ็นข้อมูลที่แก้แล้วด้วย LINE secret เพื่อส่งต่อ SSO ไม่รับ `X-Webhook-Verified`, IP หรือ cookie เป็นหลักฐานแทนลายเซ็น

ตั้งค่า SSO และ Central:

1. กำหนด `LINE_WEBHOOK_DESTINATION` ใน SSO ให้ตรง bot `userId` ของ OA จาก [Get bot info](https://developers.line.biz/en/reference/messaging-api/#get-bot-info) และกำหนด route ของ OA นั้นใน Central ไว้ล่วงหน้า ห้ามรับ URL ปลายทางจาก event
2. แนะนำให้สร้าง token เฉพาะ Central → SSO ด้วย `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'` แล้วเก็บใน secret configuration ของทั้งสองระบบ ใช้เป็น `LINE_WEBHOOK_GATEWAY_TOKEN` ฝั่ง SSO ห้ามใช้ซ้ำกับ Channel secret, Channel access token, session secret หรือ service API key
3. Central เพิ่ม `Authorization: Bearer <gateway token>` จาก configuration ของตัวเองทุกครั้ง ห้ามคัดลอก Authorization จาก request ขาเข้า พร้อมส่ง `Content-Type: application/json` และ `X-Line-Signature` เดิม ไม่ส่ง cookie หรือ forwarded headers จากผู้ใช้ต่อโดยไม่ตรวจ
4. ตั้ง LINE Developers Webhook URL เป็น URL ของ Central แล้วให้ Central ส่ง verification request ที่มี `events: []` ไป SSO ด้วย เพื่อตรวจทั้งเส้นทาง เมื่อเปิด gateway token แล้ว LINE ที่เรียก SSO ตรงโดยไม่มี token จะถูกปฏิเสธด้วย `401`
5. Build/Restart SSO และทดสอบก่อนเปิด traffic จริง การหมุน gateway token ต้องประสานทั้งสองระบบ หากค่าไม่ตรงให้แก้ configuration และ retry ภายในอายุ MFA ไม่ปิดการตรวจลายเซ็นเพื่อแก้ปัญหา

หากปล่อย gateway token ว่าง การรับตรงจาก LINE ยังคงทำงานและยังต้องมีลายเซ็นที่ถูกต้อง การ pin destination เป็นตัวเลือกสำหรับระบบเดิม แต่บังคับเมื่อเปิด gateway token; `deploy:check` เตือนเมื่อเปิด LINE MFA โดยยังไม่ pin OA ไม่มีการแก้ `.env` จริงให้อัตโนมัติ

ตัวอย่างส่วนส่งต่อใน Central **หลังตรวจลายเซ็นและเลือก route แล้ว** (`rawBody` คือ Buffer เดิมทั้งก้อน, `lineSignature` คือ header เดิมที่ตรวจแล้ว และ `gatewayToken` มาจาก secret configuration):

```js
const response = await fetch(
  'https://sso.reunion.scicu-alumni.com/api/auth/line/webhook',
  {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      'Content-Type': 'application/json',
      'X-Line-Signature': lineSignature,
      Authorization: `Bearer ${gatewayToken}`,
    },
    body: rawBody,
  },
);
// Handle acknowledgement/retry according to the status table below.
```

SSO รับ uncompressed JSON สูงสุด 64 KiB และ 100 events ต่อ request หาก batch ผสมเกินเพดาน ห้ามแบ่ง JSON แล้วแนบ signature เดิม ต้องปรับขีดจำกัดทั้งสองฝั่งหลังประเมินโหลดหรือออกแบบ protocol ใหม่ก่อนใช้งาน ไม่รองรับ envelope ที่ Central แปลงเองใน endpoint นี้

กติกา routing และการรับ MFA:

| กรณี | Central / SSO |
| --- | --- |
| `events: []` | ส่งตรวจถึง SSO; เมื่อ credentials และ destination ถูกต้องตอบ `200 {"ok":true}` |
| `event.type === "postback"` และ `new URLSearchParams(event.postback.data).has("cusa_mfa")` | Central จองเป็นงาน SSO แม้ข้อมูลผิดรูปแบบ ห้าม fallback ไป Chatbot |
| MFA postback ที่ SSO รับ | `source.type=user`, `userId` รูปแบบ `U[0-9a-f]{32}`, timestamp เป็นจำนวนเต็มไม่ติดลบต่างจากเวลา server ไม่เกิน 180,000 ms, `mode` ต้องไม่เป็น `standby` |
| `postback.data` | ยาวไม่เกิน 300 ตัวอักษร มีเพียง `cusa_mfa=<UUID>` และ `choice=<base64url 43 ตัว>` อย่างละหนึ่ง key; สลับลำดับได้ แต่ key ซ้ำรวมถึงแบบ percent-encoded หรือ key เกินจะถูกข้าม |
| `message`, `follow`, `unfollow`, `accountLink` หรือ postback ของบอต | จัดการตาม routing ของบอต; ไม่ใช่หลักฐาน MFA การผูก LINE ของ SSO ใช้ OAuth callback เดิม |
| batch มีทั้ง MFA และ event อื่น | ส่ง raw body เดิมให้ SSO ครั้งเดียวเมื่อมีงาน SSO; SSO ตรวจทีละ event และข้าม event ที่ไม่เกี่ยวข้อง/ผิดรูปแบบ แม้ไม่มี `source` โดยยังประมวลผล MFA ที่ถูกต้องใน batch ต่อได้ |

Central ต้องตรวจชนิดข้อมูลก่อนใช้ `URLSearchParams`; ฝั่ง Chatbot ต้องตัด event namespace `cusa_mfa` ออกจากการประมวลผลและจาก prompt/log ของบอต ห้ามตัดสินจากเลขสองหลัก ข้อความ `displayText`, Ref หรือสถานะว่าผู้ใช้เคยผูก LINE การเลือกเลขและปุ่มปฏิเสธต่างใช้ opaque `choice`; SSO เทียบกับ challenge และบัญชีที่ผูกเท่านั้น

ให้ SSO เป็นผู้ใช้ `replyToken` ของ MFA event เพียงระบบเดียว Central และ Chatbot ไม่ตอบ event นั้น เก็บ reply token เดิมไว้ใน raw body; token ไม่มี/ผิดรูปแบบไม่ทำให้ผล MFA ที่ถูกต้องย้อนกลับ การบันทึกผลกับ audit อยู่ใน transaction และ challenge เปลี่ยนผลได้ครั้งเดียว การกดซ้ำ/ส่งซ้ำไม่สร้าง session หรือส่งผลซ้ำ Browser เดิมต้อง consume challenge ด้วย cookie/CSRF ตาม flow เดิม

| HTTP จาก SSO | การจัดการใน Central |
| --- | --- |
| `200 {"ok":true}` | ประมวลผล request เสร็จ รวมถึงกรณีข้าม event; ไม่ใช่หลักฐานว่า MFA ผ่าน ให้ browser อ่านสถานะจาก SSO |
| `400` | JSON/envelope ผิด เช่น ไม่มี `destination` หรือ events เกิน 100; แก้ contract ไม่ retry ข้อมูลเดิมวนซ้ำ |
| `401` | gateway token, LINE signature หรือ destination ไม่ถูกต้อง; แจ้งเตือนโดยไม่ log credentials และห้าม fallback ไป Chatbot |
| `404` | LINE MFA ปิดอยู่; ตรวจ configuration |
| `413` / `415` | เกิน 64 KiB / มี Content-Encoding ที่ไม่รองรับ; แก้การส่งต่อ ไม่ retry เดิมวนซ้ำ |
| `429`, `5xx` หรือ timeout | retry แบบจำกัดจำนวนและ backoff เคารพ `Retry-After` ภายในอายุ challenge 3 นาที ใช้ raw body/signature เดิมและไม่แก้ timestamp |

อย่า mark event ว่าสำเร็จก่อน SSO ตอบสำเร็จ หากใช้คิว Central จะตอบ LINE ว่ารับแล้วได้หลังเก็บงานลง durable queue ที่กู้กลับได้เท่านั้น ใช้ `(destination, webhookEventId, consumer)` แยกสถานะงาน SSO/Chatbot สำหรับ dedup และอย่าทิ้ง `isRedelivery=true` ทุกครั้ง เพราะครั้งแรกอาจยังไม่สำเร็จ หาก SSO commit แล้วแต่ response สูญหาย retry จะไม่ทำ MFA ซ้ำ; reply เป็น best effort และไม่ได้รับประกันส่งการ์ดซ้ำหลังส่งล้มเหลว

ไม่บันทึก raw body, `choice`, `replyToken`, signature หรือ Authorization ลง access/application logs; หากจำเป็นต้องเก็บใน retry queue ให้เข้ารหัส จำกัดสิทธิ์และลบหลังจบงานหรือหมดอายุ Central ไม่ต้องได้รับ CUSA session secret หรือสิทธิ์ฐานข้อมูล SSO ส่วน `TRUST_PROXY` ต้องตรง proxy chain จริง ไม่ตั้งเป็นเชื่อทุก IP เพื่อแก้ปัญหา Central และควรตรวจโหลดกับ rate limit เดิม 600 requests/นาที/IP โดยไม่ใช้ X-Forwarded-For ที่ผู้ส่งกำหนดเองเพื่อข้ามข้อจำกัด

อ้างอิง: [LINE signature และ raw body](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/), [Webhook redelivery](https://developers.line.biz/en/docs/messaging-api/receiving-messages/#redelivered-webhooks)

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

**ห้ามผูกเบอร์ซ้ำข้ามบัญชี:** ใช้ข้อกำหนด UNIQUE ของ `phone_identities` ที่มีตั้งแต่ migration 006 บังคับทั้ง user_id, phone_hash และ firebase_uid_hash ครอบคลุมบัญชีภายในและบัญชีจากทุก Service การยืนยันพร้อมกันมีผู้สำเร็จเพียงรายเดียว ไม่มี upsert/การโอนเบอร์ให้บัญชีใหม่ เมื่อชนกันจะใช้ challenge นั้นแล้ว บันทึก failure ผ่าน Audit Outbox ใน transaction เดียวกัน และตอบ `409 PHONE_UNAVAILABLE` โดยไม่ส่งชื่อ/อีเมล/รหัสบัญชีเจ้าของเดิม หากบันทึก Audit ไม่สำเร็จ transaction จะ rollback

ไม่มี API สำหรับตรวจว่าเบอร์ของคนอื่นถูกใช้แล้วก่อนพิสูจน์การครอบครองด้วย SMS เพื่อลดการไล่ค้นข้อมูลบัญชี การตรวจนี้อาจเกิดหลัง Firebase ส่ง SMS แล้ว หน้าเว็บจะล้าง proof ที่ใช้ไม่ได้และคง cooldown เดิมไว้ ไม่ถือว่ายืนยันเบอร์สำเร็จ การ soft-delete บัญชีหรือรีเซ็ต MFA ไม่ปล่อยเบอร์ให้บัญชีอื่นอัตโนมัติ กรณีเบอร์ถูกผู้ให้บริการนำกลับมาใช้ใหม่ต้องติดต่อผู้ดูแลเพื่อตรวจสอบ รุ่นนี้ไม่เพิ่มการโอนเบอร์ด้วยตัวเอง และไม่ต้องเพิ่ม migration หรือค่า `.env`

**ขอบเขตของ cooldown:** Firebase SDK ส่ง SMS ไป Firebase โดยตรง ผู้เรียกอาจข้ามหน้า CUSA เพื่อเรียก Firebase API ได้ การจำกัดฝั่ง CUSA จึงไม่ใช่ hard cap ค่า SMS ต้องควบคุม region/quota/reCAPTCHA ที่ Firebase ด้วย โค้ดใช้ reCAPTCHA ของ Phone Auth SDK ไม่อ้างว่าเป็นการบังคับ reCAPTCHA v3 enterprise ทุก project

Firebase auth state อยู่ใน memory เท่านั้น; หลังยืนยัน/ออกจากหน้าเรียก signOut ไม่เก็บ Firebase token ใน localStorage ไม่มีการเก็บ SMS OTP ใน CUSA และข้อความ SMS ถูกกำหนดโดย Firebase ไม่ใช้ template ของ Email OTP

ประกาศความเป็นส่วนตัวรุ่น 1.2 ครอบคลุม provider และข้อมูลใหม่ การเริ่มยืนยันบันทึก purpose/version/acknowledgement ใน audit โดยไม่ใส่เบอร์หรือ ID token การถอน/ลบต้องประสานทั้ง CUSA และ Firebase; ไม่มีการลบ Firebase user ให้อัตโนมัติในรุ่นนี้

อ้างอิง: [Firebase Phone Auth](https://firebase.google.com/docs/auth/web/phone-auth), [Admin ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens), [Firebase limits](https://firebase.google.com/docs/auth/limits)

### เมื่อส่ง SMS ไม่สำเร็จ

หน้าเว็บแสดงรหัส Firebase ที่รู้จัก เช่น `auth/configuration-not-found` หรือ `auth/unauthorized-domain` เพื่อแจ้งผู้ดูแล โดยไม่แสดง provider message, customData, token หรือข้อมูลบัญชีจาก error ทั้งก้อน รหัสที่ไม่รู้จักยังใช้ข้อความกลาง ไม่มีการปิด reCAPTCHA หรือผ่อน cooldown เพื่อแก้ปัญหา

- `POST /api/auth/phone/start` ตอบ 429: ดู `Retry-After` ใน Response Headers แล้วรอให้ครบ มีทั้ง cooldown 60 วินาทีและเพดาน 3 ครั้งใน 10 นาที การขอเริ่มที่ผ่านก่อน Firebase ล้มเหลวยังคงนับ ไม่กดซ้ำต่อเนื่องหรือเปลี่ยน IP เพื่อข้ามข้อจำกัด
- `GET /v2/recaptchaConfig` ตอบ 404: ยังสรุปว่าเป็นต้นเหตุไม่ได้ SDK สามารถเปลี่ยนไปใช้ reCAPTCHA v2 ตาม [Firebase SDK](https://github.com/firebase/firebase-js-sdk/blob/main/packages/auth/src/platform_browser/strategies/phone.ts)
- `GET /v1/recaptchaParams` ตอบ 400: เปิด **DevTools → Network → recaptchaParams → Response** อ่าน `error.message` ของคำขอที่ล้มเหลว ต้องใช้ Response ไม่ใช่เพียง stack trace จาก Console ผล GET จากเครื่องอื่นที่เป็น 200 ไม่ยืนยันว่า request จาก browser มี headers/config เหมือนกันหรือส่ง SMS ได้
- `POST /v1/accounts:sendVerificationCode` ตอบ 400 พร้อม `OPERATION_NOT_ALLOWED : SMS unable to be sent until this region enabled by the app developer.`: เข้า **Firebase Authentication → Settings → SMS region policy** อนุญาตประเทศปลายทางที่ใช้งาน (เช่น Thailand/TH สำหรับ +66) แล้ว Save คงข้อจำกัดประเทศอื่นไว้ตามนโยบาย รอ cooldown/Retry-After แล้วลองใหม่ ไม่ต้องแก้ `.env`, migration หรือ reCAPTCHA เพื่อแก้ region policy นี้
- `auth/configuration-not-found` / `auth/operation-not-allowed`: ตรวจ Firebase Project ที่ตรงกับ Web config, การเริ่มใช้งาน Authentication และ Phone provider
- `auth/unauthorized-domain` / `auth/app-not-authorized` / `auth/invalid-api-key`: ตรวจ Authorized domains และข้อจำกัด API key โดยคงข้อจำกัดให้อนุญาตเฉพาะเว็บไซต์/API ที่จำเป็น
- `auth/billing-not-enabled` / `auth/quota-exceeded`: ตรวจ billing และ SMS quota ที่ Firebase อย่าถือว่าการกด retry จะแก้ configuration ได้

หลังเปลี่ยน `.env` บน Host ให้ Restart App และ reload หน้าเว็บเพื่อโหลด Firebase app configuration ใหม่ หากแก้เฉพาะการตั้งค่าใน Firebase Console ไม่ต้อง build React ใหม่ การตรวจ GET configuration ไม่ส่ง SMS และไม่ตรวจ billing, phone provider หรือการส่งข้อความจริงครบทุกขั้นตอน

## API ของหน้า CUSA (ไม่ใช้เป็น Service API)

ทุก API ใต้ตารางต้องมี cookie ของเจ้าของบัญชี; POST/DELETE ต้องมี Origin ตรง APP_ORIGIN และ X-CSRF-Token ยกเว้น LINE webhook ที่ตรวจลายเซ็นผู้ให้บริการ Callback เป็น GET ที่มี state/nonce แยก

| Method + path ใต้ `/api/auth` | สิทธิ์ / payload |
| --- | --- |
| `GET /factors` | Full session; ส่งเฉพาะสถานะ, metadata Passkey และ public Firebase config |
| `POST /passkeys/register/options` | Full session + TOTP หรือ Passkey สด; `{}` → `{challengeId,options}` |
| `POST /passkeys/register/verify` | TOTP หรือ Passkey สด; `{challengeId,name,response}` → 201 |
| `DELETE /passkeys/:id` | TOTP หรือ Passkey สด; ลบของตัวเองและถอน session อื่น |
| `POST /passkeys/authenticate/options` | Pending Google session ที่มี TOTP และ Passkey |
| `POST /passkeys/authenticate/verify` | `{challengeId,response}` → หมุน cookie เมื่อผ่าน |
| `POST /passkeys/reauth/options` | Full session, มี TOTP และ Passkey เดิม, ไม่ใช่ Recovery session; `{}` → `{challengeId,options}` |
| `POST /passkeys/reauth/verify` | `{challengeId,response}` → `{ok:true}`; ตรวจ proof แล้วอัปเดตความสดพร้อม audit |
| `POST /line/link` | TOTP หรือ Passkey สด; `{}` → `{url}` ที่ backend สร้าง |
| `GET /line/callback` | OAuth code/state จาก LINE Login |
| `DELETE /line/link` | TOTP หรือ Passkey สด; ถอดของตัวเองและถอน session อื่น |
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

## ประสบการณ์ใช้งานและข้อความยืนยัน (ตุลาคม 2026)

- `/` และ `/login` เป็นหน้า Login โดยตรง ธีมเหลืองส้ม ใช้งานบนมือถือได้ พร้อมรองรับ Reduce Motion ของอุปกรณ์
- เบอร์มือถือกรอกแบบไทย 10 หลัก เช่น `081 234 5678` ได้ รวมถึงเลขไทยและการวาง `+66812345678` ระบบแปลงเป็น E.164 ก่อนส่ง API และ Firebase ทั้งสองจุด ไม่เปลี่ยนหมายเลขโดยเดาเลขที่ขาด ไม่รับเบอร์บ้านหรือหมายเลขต่างประเทศผ่านฟอร์มนี้
- หน้า SMS ระบุว่าใช้ยืนยันการถือครองเบอร์สำหรับบัญชี CUSA SSO พร้อมชื่อ Service จาก login context ที่ backend ตรวจแล้วถ้ามี ไม่ใช้ SMS แทน MFA คง consent, reCAPTCHA, CSRF, cooldown อย่างน้อย 60 วินาที และเพดานคำขอเดิม
- **Firebase SMS ไม่รองรับข้อความกำหนดเองหรือ Ref ต่อคำขอ**: `smsTemplate.content` เป็น output-only และ `%APP_NAME%` ของ Web ใช้โดเมน จึงบังคับซ่อนโดเมนหรือแทนชื่อ Service จากโค้ดนี้ไม่ได้ UI ไม่สร้าง Ref ปลอมอ้างว่าตรงกับ SMS หากต้องการข้อความ SMS กำหนดเอง ต้องเปลี่ยนไปผู้ให้บริการที่รองรับและออกแบบการตรวจ OTP ฝั่ง server ใหม่ ดู [Google SMS template](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/Config#SmsTemplate)
- LINE ใช้ Flex Card โทนเหลืองส้ม พร้อมชื่อ Service ที่อ่านจาก session/application ฝั่ง server, Ref `LN-…`, อายุ 3 นาที, ปุ่มเลข 3 ตัวเลือกและปุ่มปฏิเสธ เลขถูกไม่ถูกเน้นแตกต่างจากตัวเลือกอื่น Ref ใช้จับคู่ข้อความกับหน้าจอ ไม่ใช้เป็นหลักฐานอนุมัติ
- ปุ่ม LINE ส่ง postback โดยไม่มี `displayText`/`text` จึงไม่เพิ่มข้อความแทนผู้ใช้ หลังตรวจลายเซ็น ผู้ส่ง การผูกบัญชี อายุคำขอ สถานะ pending และ choice ที่ออกให้แล้ว ระบบเริ่ม Loading Animation API **ก่อนเขียนผลยืนยัน** โดยทำงานคู่กับการบันทึกผล/Audit/commit ไม่รอ LINE ขณะถือ database lock ตั้งระยะ 5 วินาทีและ timeout API 1 วินาที ก่อนส่งการ์ดผลต้องให้คำขอโหลดสิ้นสุดและ commit สำเร็จ หากโหลดล้มเหลวยังบันทึกและส่งผลตามเดิม คำขอผิดหรือ replay ที่ตัดสินแล้วไม่เรียกโหลด/ตอบซ้ำ
- หาก Audit หรือ commit ล้มเหลวหลังเริ่มโหลด จะ rollback และไม่ส่งการ์ดผล ตัวโหลดไม่ใช่หลักฐานว่ายืนยันสำเร็จและหายเองเมื่อครบเวลา ตัวโหลดแสดงเฉพาะห้องแชตส่วนตัวที่กำลังเปิดอยู่ และหายเมื่อข้อความจาก OA มาถึงหรือครบ 5 วินาที ตาม [LINE loading indicator](https://developers.line.biz/en/docs/messaging-api/use-loading-indicator/) หากประมวลผลเร็วอาจเห็นเพียงชั่วครู่ ไม่มีการหน่วงผลเพื่อยืดแอนิเมชัน และไม่ได้เปลี่ยนปุ่ม Flex เดิมให้หมุน
- หลังคลิกปุ่ม LINE ระบบตรวจลายเซ็น webhook, บัญชีที่ผูก, อายุคำขอ และบันทึกผลพร้อม Audit ก่อนส่ง **การ์ดผลลัพธ์ใหม่ผ่าน Reply API** การ์ดอนุมัติระบุว่า “ยืนยันเลขสำเร็จ” และให้กลับไปหน้าจอเดิม ยังไม่อ้างว่า browser ล็อกอินสำเร็จก่อน consume challenge
- LINE Messaging API ที่ใช้ไม่มี endpoint สำหรับแก้/ลบ Flex ที่บอตส่งไปแล้ว การ์ดเดิมยังอยู่ในประวัติ แต่ปุ่มเดิมไม่เปลี่ยนผลและใช้ซ้ำไม่ได้ การ์ดผลล่าสุดไม่มีปุ่มอนุมัติซ้ำ ดู [Messaging API reference](https://developers.line.biz/en/reference/messaging-api/#send-reply-message)
- การเอาข้อความหลังแตะออกมีผลกับการ์ดที่ส่งใหม่หลัง deploy เท่านั้น การ์ดเก่ายังคง `displayText` เดิม ให้เริ่มคำขอ LINE ใหม่เมื่อตรวจรุ่นนี้
- ส่ง Reply เฉพาะตอนผลเปลี่ยนครั้งแรก ไม่ส่งซ้ำจาก webhook replay ถ้าส่ง Reply ไม่สำเร็จจะบันทึก `auth.line.reply.failure` แบบไม่เปิดเผย token โดยไม่ย้อนผล MFA; หน้าจอ browser ยังคงอ่านผลจาก server ได้ การแจ้งเตือน LINE เป็น best effort ไม่มีคิว retry ที่จะใช้ reply token หมดอายุซ้ำ
- เว็บแจ้งเข้าสู่ระบบสำเร็จเมื่อ `/auth/me` ยืนยันว่าผ่าน MFA และ phone gate ครบแล้วเท่านั้น ไม่เชื่อ `auth=success` ใน URL เพียงอย่างเดียว ไม่ขอสิทธิ์ browser notifications และไม่มีการส่ง SMS/LINE เพิ่มทุกครั้งที่เปิดหน้า
- หน้า MFA มีปุ่ม **ขอรีเซ็ต MFA** สำหรับเจ้าของบัญชีหลัง Google Login ใช้ขั้นตอนแนบหลักฐานเดิม ใส่ลายน้ำ/เข้ารหัสและรอผู้ดูแล ไม่มีปุ่มข้าม MFA การอนุมัติและกำหนดลบเอกสารไม่เปลี่ยน

รอบนี้ไม่มี schema migration หรือ `.env` ใหม่ Deploy release, Restart App แล้วทดสอบเบอร์/LINE จริงด้วยบัญชีทดสอบที่ผูกไว้ การทดสอบอัตโนมัติจำลอง provider ไม่ส่ง SMS หรือ LINE จริง ยังต้องเปิด Thailand ใน Firebase SMS region policy หากพบ `OPERATION_NOT_ALLOWED` เรื่อง region.

## นโยบาย Admin และแจ้งเตือนเบอร์โทร (4 ตุลาคม 2026)

- WebAuthn บังคับ User Verification (PIN/biometric), RP ID/origin, signature, counter และเจ้าของ credential ทั้งตอนล็อกอินและ reauthenticate
- Challenge อายุ 3 นาทีใช้ครั้งเดียว ผูก session/account/factor และ `purpose=login|reauth` ใน payload ที่เข้ารหัส ไม่รับ proof ข้ามวัตถุประสงค์ คำขอที่ค้างจากรุ่นก่อนอัปเดตต้องเริ่มใหม่
- Reauthenticate อัปเดต `mfa_method`/`authenticated_at` พร้อม audit ใน transaction เดียว ไม่ต่ออายุ session ไม่หมุน token/CSRF; frontend ส่งคำขอรายการเดิมซ้ำได้เพียงหนึ่งครั้งหลังยืนยันสำเร็จ การยกเลิกไม่ทำรายการ
- Initial enrollment ยังต้องตั้ง TOTP และเก็บ Recovery codes ก่อนเพิ่ม Passkey เช่นเดิม การเปิด/ปิด TOTP และสร้าง Recovery codes ใหม่ยังต้องกรอกรหัส TOTP ตามกระบวนการเฉพาะนั้น
- `/auth/me.factors.phoneEnabled` ใช้ร่วมกับ `phoneVerified` แสดงคำเตือนในพื้นที่บัญชีหลังล็อกอิน เฉพาะเมื่อเปิด Firebase Phone และยังไม่ยืนยันเบอร์ ปุ่มพาไปช่องกรอกเบอร์ไทยในหน้าความปลอดภัย ไม่ส่ง SMS อัตโนมัติและไม่บล็อกบัญชีที่ไม่ได้ถูกบังคับ
- บัญชี `phoneRequired=true` ยังต้องผ่าน Phone Gate ก่อนเข้าใช้งาน; บัญชีที่ยืนยันแล้วหรือระบบปิด SMS จะไม่เห็นคำเตือนเสริมนี้ การยืนยันเบอร์ไม่เปลี่ยนระดับ MFA
- รุ่นนี้ไม่เพิ่มตารางหรือ migration และไม่ต้องเพิ่มค่า `.env` ทดสอบทั้ง Admin/สมาชิก, TOTP/Passkey, MFA หมดช่วง 5 นาที, ยกเลิก reauth และเบอร์โทรทั้ง optional/required ก่อนปล่อยใช้งาน

### เลือกวิธีเข้าสู่ระบบและเปิดสิทธิ์ Admin ภายหลัง

Google ยังคงเป็นขั้นตอนแรกเพื่อผูกบัญชีและตรวจ Allowlist จากนั้นแสดงเฉพาะวิธี MFA ที่ backend ระบุว่าใช้ได้ เลือกการ์ดแล้วจึงยืนยันในส่วนด้านล่าง ไม่ส่ง OTP/LINE หรือเปิดหน้าต่าง Passkey อัตโนมัติเมื่อเลือกการ์ด เวลารอส่ง LINE ซ้ำยังคงอยู่เมื่อสลับไปวิธีอื่นแล้วกลับมา

Admin เลือก LINE ได้ตั้งแต่หน้า MFA เมื่อผ่านแล้วเข้าได้เฉพาะพื้นที่บัญชีของตน เมนู Admin และการโหลดข้อมูลผู้ดูแลยังปิดอยู่ จนกด **ยืนยันสิทธิ์ Admin** แล้วผ่าน Passkey หรือ Authenticator การยกเลิกหน้าต่างนี้ยังใช้พื้นที่บัญชีได้และไม่เปิดสิทธิ์ Admin ไม่มี popup บังคับทันทีหลัง LINE Login

Email OTP แสดงเฉพาะบัญชีที่ยังไม่เปิด TOTP; Recovery code ยังคงใช้กู้บัญชีตามนโยบายเดิม และ SMS ยังคงยืนยันการครอบครองเบอร์ ไม่เพิ่มเป็นทางลัดล็อกอิน ข้อจำกัด 5 นาทีสำหรับรายการสำคัญ, CSRF, single-use proof, cooldown และการตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์คงเดิม
