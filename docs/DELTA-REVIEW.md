# ผลทบทวน Ultimate Delta Blueprint

ตัดสินใจตามโค้ดจริงและข้อจำกัด HostAtom/Plesk ไม่ถือว่าคำว่า Enterprise, Zero Trust หรือ Unlimited Bandwidth รับรองความปลอดภัยหรือรองรับผู้ใช้พร้อมกันหลักแสนได้โดยไม่วัดผล

## ตารางตัดสินใจ

| ข้อเสนอ | ผลที่ใช้ในรุ่นนี้ | เหตุผล / ขอบเขต |
| --- | --- | --- |
| Cache Frontend | เพิ่ม immutable 1 ปีเฉพาะ Vite assets ที่ชื่อมี content hash; HTML/documents revalidate; API no-store | ไม่ cache login, token, installer หรือข้อมูลผู้ใช้แบบ shared cache |
| Nginx เสิร์ฟ assets | มีแนวทางให้ HostAtom ตั้งเฉพาะ `/assets/` | ต้องได้รับการตั้ง location จาก Host; ไม่ย้าย Document Root ไป Application Root |
| Unix socket DB | เพิ่ม `DB_SOCKET_PATH` และ preflight | เลือกใช้เมื่อ Host ให้ path/permissions จริง ไม่มี TCP fallback เงียบ; ไม่รับรองเร็วขึ้น 10–20% |
| Pool/Cluster | คง pool จำกัด 20, queue จำกัด 100 และ UTC | Plesk Passenger ดูแล process ไม่เพิ่ม PM2 ซ้อน; cluster คือหลาย process ไม่ใช่ multithread |
| JWT + Redis refresh | คง opaque tokens + BFF + PKCE S256 + introspection cache สูงสุด 5 วินาที | JWT ตรวจ offline ทำให้ revocation ล่าช้าถึง expiry; การเพิ่ม JWT/refresh token ต้องออกแบบ rotation/reuse detection/key rotation เป็นรุ่น protocol ใหม่ |
| Redis Log Broker | คง transactional MariaDB Outbox | ป้องกัน dual-write สำหรับการเปลี่ยนข้อมูลสิทธิ์; ไม่แทนด้วย Redis fire-and-forget |
| Google Secret Manager | เตรียมแนวทาง operation, ยังไม่เชื่อม project จริง | ต้องมี bootstrap identity/IAM/WIF และ rotation plan; การย้าย secret แล้ววาง service-account private key แบบเดิมไม่ได้ลบความเสี่ยงทั้งหมด |
| Node.js WAF | คง Helmet/CSP, validation, SQL parameters, bounded body, CSRF และ rate limits | Helmet ไม่ใช่ WAF; express-mongo-sanitize ไม่ป้องกัน MariaDB SQL injection; ไม่เพิ่ม sanitizer ที่ทำข้อมูลเสีย |
| Auto-ban 24 ชั่วโมง | คง user+IP quotas, OTP cooldown และ lock MFA หลังผิด 5 ครั้ง 15 นาที | การแบน IP ยาวจากเหตุการณ์ไม่กี่ครั้งกระทบผู้ใช้ร่วม NAT; เส้นทาง proxy ต้องเชื่อเฉพาะที่ตรวจแล้ว |
| Off-site backups | ระบุ runbook ให้ใช้ Host/Plesk scheduler และระบบสำรองที่ดูแลได้ | node-cron อาจไม่ทำงานเมื่อ Passenger หลับ/restart; ยังไม่มีปลายทาง bucket/IAM/restore approval สำหรับสำรองจริง |
| Passkeys | เพิ่มจริงเป็น MFA หลัง Google | ตรวจ signature, RP/origin, UV, challenge/counter; ไม่กล่าวอ้างกำจัด phishing 100% |
| LINE Number Matching | เพิ่มจริงเป็นวิธีทางเลือกหลังผูกด้วย TOTP | ไม่บังคับทุกคนย้ายจาก TOTP; signed webhook + account/session binding; เปิดด้วย provider credentials |
| First-time SMS | เพิ่ม Firebase Phone Auth ตามบริการของผู้ใช้ | ยืนยันการถือครองเบอร์ ไม่ใช่ KYC/หนึ่งคนหนึ่งเบอร์; required เปิดเฉพาะบัญชีใหม่; quota ต้องคุมที่ Firebase |
| MFA fallback | คง Google, TOTP, Recovery และ Email OTP ตามนโยบายเดิม | บัญชี TOTP ไม่ลดระดับเป็น Email OTP อัตโนมัติเมื่อ LINE ล่ม |
| Dynamic branding | คงชื่อ Service และ origin ที่ลงทะเบียน, แบรนด์หลัก CUSA SSO | ไม่รับ logo/color/redirect จาก query ของผู้โจมตี; การเพิ่ม asset upload ต้องออกแบบ validation/storage เพิ่ม ยังไม่ได้เพิ่มธีมตาม Service |
| Public auto-register | คง Allowlist + membership/role ปิดเป็นค่าเริ่มต้น | การข้าม allowlist กระทบ account revocation ทุกจุด ต้องแยก registration policy ต่อ Service และ abuse/quota ก่อนเปิดจริง รุ่นนี้ยังไม่มี public registration |
| Passwordless enforcement | มีอยู่แล้ว: Google-only ก่อน MFA | ไม่มี local password form ให้ซ่อน |
| Service-scoped roles | มีอยู่แล้วและคงไว้ | Token identity/userinfo กรอง roles ของ app เดียว; ระบบลูกตีความสิทธิ์ธุรกิจเอง |
| OIDC discovery | ยังไม่ประกาศว่าเป็น OIDC Provider | ต้องมี ID token, JWKS/signing-key rotation, nonce/scopes/claims/discovery และทดสอบ conformance ครบ ไม่เพิ่ม discovery ปลอมทับ OAuth contract เดิม |
| Single Logout webhooks | ยังไม่เปิด webhook SLO | ต้องตรวจ callback SSRF, signing, delivery retries/idempotency; ปัจจุบันถอน token/session ที่ SSO แล้ว BFF ตรวจ introspection ภายใน window ที่กำหนด |
| PDPA consent versions | เพิ่ม version 1.2 และ version/purpose ในการรับทราบ Firebase; ไม่บังคับ consent ครอบทุกเรื่อง | Privacy notice acknowledgement, terms และ optional consent เป็นคนละเรื่อง; ไม่มีระบบ Admin publish consent version สำหรับทุกกิจกรรมในรุ่นนี้ |
| Metrics | เพิ่ม Prometheus endpoint ที่ใช้ dedicated Bearer token | ไม่ใช้ “URL ลับ” เป็นการควบคุมสิทธิ์; เปิดเฉพาะเมื่อใส่ METRICS_TOKEN |
| Admin kill switch | เพิ่มถอน session/token ทุกอุปกรณ์โดยคง account/roles/MFA | ต้อง TOTP สดและ audit ใน transaction; หากต้องห้าม login ใหม่ให้ถอน allowlist |
| MFA bypass code | ไม่เพิ่ม | จะตัดผ่านกระบวนการกู้ MFA ที่มีหลักฐานและผู้อนุมัติ ใช้ Recovery code/คำขอรีเซ็ตที่มีอยู่ |

## Cache และ single-host capacity

Node ส่ง `Cache-Control: public, max-age=31536000, immutable` เฉพาะไฟล์ใต้ `web/dist/assets` ที่มี hash และ extension ที่อนุญาต ไฟล์ไม่มี hash ใช้ `no-cache`; `/api/*` ใช้ `no-store` การ immutable มีผลตาม max-age ไม่ใช่ “เก็บถาวร” อ้างอิง [Express static](https://expressjs.com/en/5x/api/express/)

หาก HostAtom ให้เพิ่ม Nginx location ให้เสิร์ฟ `/assets/` จาก directory ที่ build แล้วเท่านั้น, ไม่เปิด autoindex, ไม่ fallback auth/API ไป cache, รักษา Content-Type/nosniff และ HTTPS/security headers ที่เกี่ยวข้อง ทดสอบไฟล์เก่าคงอยู่ระหว่าง deployment และ HTML revalidate ก่อน purge รุ่นเก่า ไม่ใส่ snippet ที่มี absolute filesystem path เดาเองใน Plesk

`DB_SOCKET_PATH=` ว่างคง TCP ตามเดิม ถ้า Host ให้ socketจริง ใส่ absolute path, `DB_TLS=false` สำหรับ local socketตามเงื่อนไขhostและตรวจ `deploy:check` ไม่มีการปิด TLS อัตโนมัติ ค่า host/port ไม่ถูกใช้เมื่อเลือก socket ตาม [mysql2 Connection options](https://github.com/sidorares/node-mysql2/blob/master/typings/mysql/lib/Connection.d.ts) การเพิ่มจำนวน connections/process ต้องคิดรวมทุก Passenger instance, jobs, backup และ DBA headroom แล้ว load-test ด้วยข้อมูลจำลองในสภาพแวดล้อมที่ได้รับอนุญาต

## Metrics และ kill switch

ตั้ง `METRICS_TOKEN` เป็น random 32-byte base64url, Restart, แล้วให้ Prometheus scrape `GET /api/metrics` โดยส่ง `Authorization: Bearer ...` ผ่าน HTTPS เก็บ secret ใน monitoring credential file ไม่ใส่ใน query หรือ frontend เมื่อไม่ตั้งได้ 404; credentialผิดได้401

ค่าที่ส่ง: process user/system CPU seconds, RSS, Node heap, uptime, audit-worker running/consecutive failures ไม่มีรายชื่อผู้ใช้ IP token payload หรือ environment secret ค่านี้เป็น **process ที่รับ request เท่านั้น** ไม่ใช่ CPU/RAM ของ Host ทั้งเครื่องหรือผลรวมทุก Passenger worker; Grafana ควรอ่านจาก Prometheus และมีระบบภายนอกตรวจ `/api/ready`, scheduled-job failures และ audit backlog ผ่าน `ops:check` ด้วย

หน้า Users มี **ออกจากระบบทุกอุปกรณ์** API `DELETE /api/admin/users/:id/sessions` ยกเลิก session, token และ authorization codes ภายใน transaction เดียวกับ audit ไม่ลบ user, allowlist, membership หรือ roles หาก outboxเขียนไม่ได้การถอนทั้งหมด rollback เซสชันผู้ดูแลต้อง full/TOTPไม่เกิน5นาที; frontendไม่ให้กดบัญชีตัวเองจากหน้านี้ ใช้หน้าเซสชันของตัวเองได้ การ introspection cache อาจทำให้ระบบลูกเห็นผลช้าไม่เกิน5วินาที; ใช้TTL0เมื่อต้องตรวจทันที และระบบลูกต้องไม่เก็บผลนานกว่าที่ตกลง

## สิ่งที่ยังต้องตัดสินใจก่อนขยาย protocol/infrastructure

- OIDC/JWT: เลือก certified provider/library หรือทำ conformance plan, signing-key ownership, refresh rotation, issuer/audience และผล revocation กับแต่ละ Service
- Public registration: กำหนด Service ที่เปิดรับ, role เริ่มต้นที่ไม่มีสิทธิ์ admin, phone/abuse policy และการเพิกถอนข้าม Service โดยไม่ข้ามallowlistแบบqueryparameter
- SLO: ลงทะเบียน HTTPS backchannel ต่อ Service, ตรวจ DNS/IP/redirect เพื่อกัน SSRF, ลงลายเซ็น, delivery outbox/retries และ downstream idempotency
- Backup: ระบุ bucket/account/region, encryption key ownership, least-privilege upload, retention/object lockตามนโยบาย, restore drill; ตรวจ snapshot exclusion ของหลักฐานก่อนอัปโหลดจริง
- Secret Manager: ระบุ Google project/secret versions, ADC/WIF หรือ dedicated account, timeout/fail-closed startup, rotationและการเก็บกุญแจเก่าที่จำเป็นต่อข้อมูลเดิม ห้ามสร้างกุญแจใหม่ทุก restart

รายละเอียดมาตรฐาน: [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html), [Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html), [OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)

คำสั่ง `OPTIMIZE TABLE audit_outbox` ไม่ตั้งอัตโนมัติรายสัปดาห์โดยไม่วัด free space/locking/disk headroom และความจำเป็นจริง Outbox churn อาจใช้พื้นที่เดิมซ้ำได้; maintenance ต้องวางแผนตาม MariaDB version/engineของhost ไม่รับรองว่า single server ปลอด bottleneck หรือการลบ partition ด้วยมือป้องกันความผิดพลาดได้100%
