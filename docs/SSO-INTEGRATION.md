# เชื่อมต่อระบบอื่นกับ CUSA SSO

API นี้เป็น SSO สำหรับระบบภายในที่ผู้ดูแลอนุมัติ ใช้ authorization code + PKCE S256, Google Login และ MFA ของ CUSA ก่อนออก token เป็น **custom first-party SSO API** ไม่ใช่ OpenID Connect provider แบบสมบูรณ์: ไม่มี discovery, ID token, refresh token, dynamic client registration หรือหน้าขอ consent สำหรับบุคคลที่สาม

## ตั้งค่า application

1. เพิ่ม application ในหน้า Applications พร้อม callback URL แบบเต็ม เช่น `https://portal.example.com/auth/callback` ใช้ HTTPS; HTTP อนุญาตเฉพาะ loopback สำหรับพัฒนา
2. สร้าง API key ผูกกับ application นั้น ให้สิทธิ์ `identity:read` สำหรับแลก code และ `token:introspect` สำหรับตรวจสถานะ เก็บ key ใน secret manager/ตัวแปร environment ของ backend
3. ตั้ง `SSO_ORIGIN`, `SSO_APPLICATION_ID`, `SSO_API_KEY`, `SSO_REDIRECT_URI` และ `PORTAL_ORIGIN` ใน backend ของระบบปลายทาง
4. สร้าง Role และเพิ่มผู้ใช้เป็นสมาชิกของ Service นี้จากหน้า “สิทธิ์แต่ละ Service” แล้วกำหนดหน่วยงานและ Role ตาม [คู่มือ](SERVICE-ACCESS.md) บัญชีที่อยู่ใน allowlist อย่างเดียวยังเข้า Service ไม่ได้
5. เปิด backend session storage ที่ใช้ร่วมกันได้ เช่น Redis/MariaDB พร้อม cookie `HttpOnly; Secure; SameSite=Lax` และป้องกัน CSRF ที่ระบบปลายทาง

**ห้ามวาง API key ใน React, localStorage, sessionStorage, URL หรือ repository** Browser สร้าง PKCE และรับ authorization code; backend เป็นผู้แลก code ด้วย API key และเก็บ access token

## Endpoint และอายุข้อมูล

| Endpoint | การยืนยันตัวตน | ผลลัพธ์ |
| --- | --- | --- |
| `GET /api/sso/login-context` | ไม่ต้องมี session; ตรวจ authorization parameters เดียวกับ authorize | ชื่อ/Origin ของแอปที่ลงทะเบียนและ internal returnTo สำหรับหน้า Login |
| `GET /api/sso/authorize` | CUSA session ที่ผ่าน MFA | Redirect ไป callback พร้อม `code` และ `state` |
| `POST /api/sso/token` | `X-API-Key`, scope `identity:read` | Opaque bearer token อายุสูงสุด 300 วินาที |
| `POST /api/sso/introspect` | `X-API-Key`, scope `token:introspect` | `{active:false}` หรือข้อมูลผู้ใช้และ `aud` ของ application |
| `GET /api/sso/userinfo` | `Authorization: Bearer ACCESS_TOKEN` | `{sub,email,name,given_name,family_name,department,roles,aud,email_verified:true}` |
| `OPTIONS /api/sso/userinfo` | Origin ของ application ที่ยังใช้งาน | CORS preflight สำหรับ GET และ Authorization เท่านั้น |

Authorization code มีอายุ 90 วินาที ใช้ได้ครั้งเดียว และผูกกับ application, callback, PKCE และ CUSA session เดิม `state` ต้องเป็น base64url 32–128 ตัวอักษร สร้างด้วย CSPRNG อย่างน้อย 32 bytes; verifier ยาว 43–128 ตัวอักษรตาม PKCE และ challenge ต้องเป็น SHA-256 base64url แบบไม่มี padding

Callback ต้องตรงกับที่ลงทะเบียนทุกตัวอักษร ไม่มี wildcard เมื่อ callback หรือ request ไม่ถูกต้อง API จะตอบ JSON error โดยไม่ redirect ผู้ใช้ที่ยังไม่ login/ยังไม่ผ่าน MFA จะไปหน้า `/login` ของ CUSA SSO พร้อม internal `returnTo` ที่ผ่านการตรวจแล้ว

Token เป็นค่า opaque จาก `crypto.randomBytes(32)` (256-bit CSPRNG) แล้ว encode base64url เป็น 43 ตัวอักษร ฐานข้อมูลเก็บเฉพาะ HMAC-SHA-256 digest ที่ใช้ secret นอกฐานข้อมูล ต้องเรียก introspection เพื่อดูสถานะ Query ตรวจ session ที่ผ่าน MFA, อายุ session/token, allowlist, สถานะ soft delete, สมาชิก/Role ใน Service และ application API key แต่ละชุดตรวจได้เฉพาะ token ของ application ตัวเอง การ revoke API key หยุดการแลก code/ตรวจ token ด้วย key นั้น; token ที่ออกไปแล้วจะหมดอายุภายใน 5 นาทีหรือถูกยกเลิกผ่าน session/application

Introspection มี LRU cache 10,000 entries และรวมคำขอพร้อมกันของ `(apiKeyHash,tokenHash)` เดียวกัน TTL สูงสุด 5 วินาที โดยไม่เกินเวลา expiry ที่เร็วที่สุดของ token, session และ API key (`exp` ใน response เป็น effective expiry นี้) การถอนสิทธิ์จึงอาจช้าสูงสุด 5 วินาที ตั้ง `INTROSPECTION_CACHE_SECONDS=0` เมื่อต้องตรวจทุกครั้ง ส่วน userinfo ไม่มี cache และตรวจสถานะปัจจุบันทุกคำขอ ไม่ cache ผลล้มเหลว/ไม่มีสิทธิ์ ข้อมูลและ token ไม่ถูกส่งผ่าน browser cache

หากระบบลูกเพิ่ม cache อีกชั้น ระยะ delay ของ revocation อาจสะสม จึงไม่เปิด cache ในตัวอย่าง BFF นี้ ใช้ NTP ให้เวลาเครื่องตรงกันและไม่ต่ออายุ token ที่หมดอายุด้วย clock-skew grace period ผล `active:false` ต้องปฏิเสธเสมอ ตั้ง Redis shared limiter สำหรับ traffic สูงและปรับ `DB_CONNECTION_LIMIT` (ค่าเริ่มต้น 20), `DB_QUEUE_LIMIT` (100) ให้เหมาะกับงบ connections รวมทุก instance

ตัวอย่างเรียกจาก backend:

```http
POST /api/sso/token
Content-Type: application/json
X-API-Key: <server-side secret>

{"grant_type":"authorization_code","code":"<callback code>","redirect_uri":"https://portal.example.com/auth/callback","code_verifier":"<original verifier>"}
```

```json
{"access_token":"<opaque token>","token_type":"Bearer","expires_in":300,"scope":"identity:read"}
```

```http
POST /api/sso/introspect
Content-Type: application/json
X-API-Key: <server-side secret>

{"token":"<opaque token>"}
```

```json
{"active":true,"sub":"<user UUID>","email":"person@example.com","name":"Person","given_name":"Person","family_name":"","department":"Finance","roles":["viewer"],"exp":2000000000,"aud":"<application UUID>","scope":"identity:read"}
```

## หน้าเข้าสู่ระบบกลาง

ให้ Service เริ่มที่ `/api/sso/authorize` เสมอพร้อม state และ PKCE; หน้า `/login` เป็น View ภายใน flow และไม่ใช่ URL ที่ใช้แทน authorize ตรง ๆ หน้า Login อ่านชื่อแอป/Origin จาก `/api/sso/login-context` ซึ่งตรวจ callback และพารามิเตอร์ทั้งหมดจากฐานข้อมูล ไม่รับชื่อหรือ URL ปลายทางจาก query ที่ไม่ได้ตรวจสอบ Context ไม่ออก code/token และปุ่ม Google เก็บเฉพาะ internal returnTo เดิม หลัง MFA ย้อนกลับไป authorize เพื่อตรวจสิทธิ์ล่าสุดก่อนออก code

## ตรวจ Role ของ Service

`roles` เป็นรหัสที่ Admin กำหนดแยกในแต่ละ Service; `department` เป็นหน่วยงานใน Service นี้ ตรวจ Role ฝั่ง backend หลัง introspection และผูกกับ business permissions ของระบบปลายทางเอง เช่น:

```js
function requireRole(role) {
  return (req, res, next) => {
    if (!Array.isArray(req.identity?.roles) || !req.identity.roles.includes(role)) return res.sendStatus(403);
    next();
  };
}
// Place after requireIdentity; use the application's CSRF middleware for mutations.
app.get('/api/approval-queue', requireIdentity, requireRole('approver'), (req, res) => {
  res.json({ userId: req.identity.sub });
});
```

เปลี่ยน membership/Role จะยกเลิก token เดิมเฉพาะ Service นี้ ให้เริ่ม authorization ใหม่เพื่อรับสิทธิ์ล่าสุด; cache delay ตามที่ระบุข้างต้น ไม่ได้รับสิทธิ์ CUSA Admin จาก Role ของ Service

## ตัวอย่าง backend ของระบบปลายทาง

ตัวอย่าง Express 5 นี้สมมติว่ามี `express.json()`, `express-session` พร้อม persistent store, HTTPS, rate limit และ error handler อยู่แล้ว เก็บ session ฝั่ง server เท่านั้น ใช้ `sub` เป็นรหัสผู้ใช้; ไม่ใช้ชื่อ/email ที่ frontend ส่งมาเป็นหลักฐานการ login

```js
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const SSO = new URL(process.env.SSO_ORIGIN).origin;
const APP_ID = process.env.SSO_APPLICATION_ID;
const API_KEY = process.env.SSO_API_KEY;
const CALLBACK = process.env.SSO_REDIRECT_URI;
const PORTAL = process.env.PORTAL_ORIGIN;
const hash = value => createHash('sha256').update(value).digest();
const save = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
const prepareSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
const exchangeSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
}).strict();

function sameOrigin(req, res, next) {
  if (req.get('Origin') !== PORTAL) return res.sendStatus(403);
  next();
}

async function ssoRequest(path, body) {
  const response = await fetch(`${SSO}/api/sso/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('SSO rejected the request');
  return response.json();
}

app.post('/auth/sso/prepare', sameOrigin, async (req, res) => {
  const parsed = prepareSchema.safeParse(req.body);
  if (!parsed.success) return res.sendStatus(400);
  const { state, challenge } = parsed.data;
  req.session.sso = { stateHash: hash(state).toString('hex'), challenge, createdAt: Date.now() };
  await save(req);
  const query = new URLSearchParams({
    response_type: 'code', client_id: APP_ID, redirect_uri: CALLBACK,
    state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  res.set('Cache-Control', 'no-store').json({ authorizeUrl: `${SSO}/api/sso/authorize?${query}` });
});

app.post('/auth/sso/exchange', sameOrigin, async (req, res) => {
  const parsed = exchangeSchema.safeParse(req.body);
  const flow = req.session.sso;
  if (!parsed.success || !flow || Date.now() - flow.createdAt > 10 * 60 * 1000) return res.sendStatus(400);
  const { code, state, verifier } = parsed.data;
  const stateMatches = timingSafeEqual(hash(state), Buffer.from(flow.stateHash, 'hex'));
  const challengeMatches = hash(verifier).toString('base64url') === flow.challenge;
  if (!stateMatches || !challengeMatches) return res.sendStatus(400);
  delete req.session.sso;
  await save(req);

  const token = await ssoRequest('token', {
    grant_type: 'authorization_code', code, redirect_uri: CALLBACK, code_verifier: verifier,
  });
  const identity = await ssoRequest('introspect', { token: token.access_token });
  if (!identity.active || identity.aud !== APP_ID) return res.sendStatus(401);
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.ssoToken = token.access_token; // server-side store; never return this secret to the browser
  await save(req);
  res.set('Cache-Control', 'no-store').json({ ok: true });
});

// Run before EVERY protected operation. Central cache allows up to 5 seconds of revocation delay.
async function requireIdentity(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!req.session.ssoToken) return res.sendStatus(401);
  const identity = await ssoRequest('introspect', { token: req.session.ssoToken });
  if (!identity.active || identity.aud !== APP_ID || identity.exp <= Math.floor(Date.now() / 1000)) {
    delete req.session.ssoToken;
    await save(req);
    return res.sendStatus(401);
  }
  req.identity = identity;
  next();
}

app.get('/api/private-profile', requireIdentity, (req, res) => {
  res.json({ sub: req.identity.sub, name: req.identity.name });
});
```

เมื่อ token หมดอายุ ให้เริ่ม authorization flow ใหม่ CUSA session ที่ยังใช้งานและผ่าน MFA แล้วจะออก code ใหม่ได้โดยไม่ต้องกรอก OTP ซ้ำทุก 5 นาที หาก SSO ติดต่อไม่ได้ ให้ backend ปฏิเสธ protected operation; อย่า fallback เป็น authenticated

## ตัวอย่าง browser PKCE

ใช้ Web Crypto ผ่าน HTTPS ส่ง API key เฉพาะ backend ตัวอย่างนี้เก็บ verifier/state ชั่วคราวใน sessionStorage และผูกข้อมูลชุดเดียวกันกับ server session ผ่าน `/auth/sso/prepare`

```js
const base64url = bytes => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export async function startSso() {
  const verifier = random();
  const state = random();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  const response = await fetch('/auth/sso/prepare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, challenge }),
  });
  if (!response.ok) throw new Error('Cannot start SSO');
  const { authorizeUrl } = await response.json();
  sessionStorage.setItem('sso-flow', JSON.stringify({ state, verifier }));
  location.assign(authorizeUrl);
}

export async function finishSso() {
  const parameters = new URLSearchParams(location.search);
  const code = parameters.get('code');
  const state = parameters.get('state');
  const saved = sessionStorage.getItem('sso-flow');
  sessionStorage.removeItem('sso-flow');
  history.replaceState({}, '', location.pathname); // remove code before loading analytics/third-party assets
  const flow = saved ? JSON.parse(saved) : null;
  if (!flow || !code || state !== flow.state) throw new Error('Invalid SSO transaction');
  const response = await fetch('/auth/sso/exchange', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, state, verifier: flow.verifier }),
  });
  if (!response.ok) throw new Error('SSO failed; start sign-in again');
  location.replace('/');
}
```

ตั้ง `Referrer-Policy: no-referrer` และ `Cache-Control: no-store` บนหน้า callback; หลีกเลี่ยง third-party script/analytics บนหน้านี้ ไม่บันทึก code, verifier, bearer token, API key หรือ query ของ callback ลง access log

## CORS และการตรวจสถานะ

รองรับ CORS เฉพาะ `/api/sso/userinfo` โดยคำนวณ origin จาก callback ของ application ที่ยังไม่ revoke: preflight อนุญาต GET และ Authorization เท่านั้น ไม่มี wildcard และไม่มี `Access-Control-Allow-Credentials` Actual GET ต้องใช้ token ของ application ที่มี origin ตรงกับ `Origin` ของ request แม้ origin อื่นจะลงทะเบียนอยู่ก็ตาม ไม่มี CORS สำหรับ `/token` หรือ `/introspect` เพราะต้องใช้ backend API key

ถ้าระบบมีเหตุจำเป็นต้องใช้ userinfo จาก browser ให้ถือ bearer token เป็น secret อายุสั้นและเก็บใน memory เท่านั้น รูปแบบ BFF ตัวอย่างข้างบนไม่ต้องส่ง bearer token ให้ browser และเป็นค่าตั้งต้นที่แนะนำ

`userinfo` เป็นข้อมูลผู้ใช้สำหรับ token; ระบบปลายทางควรใช้ introspection และตรวจ `aud === SSO_APPLICATION_ID` ก่อนตัดสินใจให้เข้าถึงข้อมูลของระบบตนเอง อย่าใช้แค่ HTTP 200, email หรือ `email_verified` แทนการตรวจ token

## การทดสอบ

`npm test` มี HTTP tests สำหรับ callback validation, PKCE/state, pending MFA, API key/scope, error handling และ CORS; model tests ใช้ injected transaction adapter ตรวจ replay, cross-application exchange/introspection, rollback และ revocation โดยไม่เชื่อม production database

ก่อนเปิด production ต้องทดสอบกับ MariaDB สำหรับ environment ทดสอบ: ใช้ code เดียวกันแลกพร้อมกันสอง request (สำเร็จหนึ่งครั้ง), revoke session/application/allowlist/soft-delete user แล้วตรวจทั้ง introspect และ userinfo, ทดสอบ key หมดอายุและ key ของ application อื่น รวมถึง CORS สอง origin จริง ชุด unit tests ไม่แทนการทดสอบ transaction/isolation บน MariaDB จริง

แนวทาง security อ้างอิง [OAuth 2.0 Security Best Current Practice — RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), [PKCE — RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html) และ [Token Introspection — RFC 7662](https://www.rfc-editor.org/rfc/rfc7662.html) การใช้แนวทางเหล่านี้ไม่ได้หมายความว่า API นี้ผ่านการรับรอง OAuth/OIDC interoperability
