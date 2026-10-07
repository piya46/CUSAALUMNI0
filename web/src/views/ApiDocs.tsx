import { useState } from 'react';
import { Download, Plus, Search } from 'lucide-react';
import spec from '../../public/openapi.json';
import { CopyButton,SectionHeading } from '../components/ui';
import type { Page } from '../models/types';
import './api-docs.css';

type Schema={$ref?:string;type?:string|string[];format?:string;description?:string;pattern?:string;enum?:string[];properties?:Record<string,Schema>;required?:string[];items?:Schema;oneOf?:Schema[]};
type Operation={operationId:string;summary:string;description:string;security?:Array<Record<string,unknown>>;parameters?:Array<{name:string;in:string;required?:boolean;description?:string;schema:Schema}>;requestBody?:{content:Record<string,{schema:Schema}>};responses:Record<string,{description:string;content?:Record<string,{schema:Schema;example?:unknown;examples?:Record<string,{value:unknown}>}>}>;'x-codeSamples'?:Array<{lang:string;source:string}>};
const operations=Object.entries(spec.paths).flatMap(([path,item])=>Object.entries(item).map(([method,op])=>({path,method,op:op as Operation})));
function resolve(schema:Schema):Schema{return schema.$ref?(spec.components.schemas as Record<string,Schema>)[schema.$ref.split('/').at(-1)!]:schema;}
const errors=[['400','invalid_request / invalid_grant','ตรวจ format, callback และ PKCE; code/refresh หมดอายุหรือถูกใช้แล้วให้เริ่ม flow ใหม่'],['400','unsupported_grant_type','ใช้ authorization_code หรือ refresh_token'],['401','invalid_client','ตรวจ application-bound API key, วันหมดอายุและการ revoke'],['401','invalid_token','Bearer token ใช้ไม่ได้หรือหมดอายุ'],['403','insufficient_scope / cors_denied','ตรวจ key scope และ origin; ไม่แก้ด้วย wildcard CORS'],['200','active: false','ปฏิเสธ protected operation แล้วเริ่ม authorization ใหม่'],['429','RATE_LIMITED','รอตาม Retry-After และใช้ exponential backoff พร้อม jitter'],['503','AUDIT_UNAVAILABLE / RATE_LIMIT_UNAVAILABLE','Fail closed; ตอบผู้ใช้ว่าบริการไม่พร้อม อย่าให้ผ่านด้วยข้อมูลเก่า']];
const bff=`import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// Express 5 + persistent server session store, HTTPS, CSRF & rate limits.
const SSO = process.env.SSO_ORIGIN;
const APP_ID = process.env.SSO_APPLICATION_ID;
const CALLBACK = process.env.SSO_REDIRECT_URI;
const KEY = process.env.SSO_API_KEY; // server only
const hash = value => createHash('sha256').update(value).digest();
const save = req => new Promise((ok, no) =>
  req.session.save(error => error ? no(error) : ok()));

app.get('/auth/login', async (req, res) => {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  req.session.sso = { stateHash: hash(state).toString('hex'),
    verifier, createdAt: Date.now() };
  await save(req); // persist BEFORE redirecting
  const query = new URLSearchParams({ client_id: APP_ID,
    redirect_uri: CALLBACK, response_type: 'code', state,
    code_challenge: hash(verifier).toString('base64url'),
    code_challenge_method: 'S256', scope: 'identity:read profile email' });
  res.set('Cache-Control', 'no-store').redirect(303,
    SSO + '/api/sso/authorize?' + query);
});

async function callSso(path, body) {
  const response = await fetch(SSO + '/api/sso/' + path, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('SSO unavailable or rejected');
  return response.json(); // log status/request-id, never secrets
}

app.get('/auth/callback', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const { code, state, error } = req.query;
  const flow = req.session.sso;
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(state)
    || !flow || Date.now() - flow.createdAt > 10 * 60 * 1000
    || !timingSafeEqual(hash(state), Buffer.from(flow.stateHash, 'hex')))
    return res.sendStatus(400);
  delete req.session.sso;
  await save(req);
  if (error === 'access_denied') return res.redirect(303, '/login?reason=consent_denied');
  if (error !== undefined || typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code))
    return res.sendStatus(400);
  const token = await callSso('token', { grant_type: 'authorization_code',
    code, redirect_uri: CALLBACK, code_verifier: flow.verifier });
  const identity = await callSso('introspect', { token: token.access_token });
  if (!identity.active || identity.aud !== APP_ID ||
    identity.exp <= Math.floor(Date.now() / 1000)) return res.sendStatus(401);
  await new Promise((ok, no) => req.session.regenerate(e => e ? no(e) : ok()));
  req.session.ssoToken = token.access_token; // never returned to React
  await save(req);
  res.redirect(303, '/'); // remove code/state from the next page URL
});

async function requireIdentity(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!req.session.ssoToken) return res.sendStatus(401);
  const identity = await callSso('introspect', { token: req.session.ssoToken });
  if (!identity.active || identity.aud !== APP_ID ||
    identity.exp <= Math.floor(Date.now() / 1000)) {
    delete req.session.ssoToken; await save(req); return res.sendStatus(401);
  }
  req.identity = identity; next();
}

app.get('/api/approvals', requireIdentity, (req, res) => {
  if (!req.identity.roles.includes('approver')) return res.sendStatus(403);
  res.json({ userId: req.identity.sub });
});
// Add Origin + CSRF validation for portal writes/logout.
// Add a safe error handler; SSO timeout returns 503, never authenticated.
// Each browser session supports one outstanding login in this example.`;

export function ApiDocs({navigate,copied,copy}:{navigate:(page:Page)=>void;copied:string|null;copy:(value:string)=>void}) {
  const [search,setSearch]=useState('');
  const selected=operations.filter(({path,op})=>`${path} ${op.summary}`.toLowerCase().includes(search.toLowerCase()));
  function code(value:string){return <div className="api-code"><CopyButton value={value} copied={copied} onCopy={copy}/><pre><code>{value}</code></pre></div>;}
  return <><SectionHeading eyebrow="DEVELOPER DOCUMENTATION" title="CUSA SSO API" description="Authorization Code + PKCE S256 · API reference v1.5 · Consent & Refresh">
    <a className="button secondary" href="/openapi.json" download><Download size={16}/>OpenAPI 3.1</a><button className="button primary" onClick={()=>navigate('applications')}><Plus size={16}/>จัดการแอป</button>
  </SectionHeading><div className="api-docs-layout"><nav className="api-docs-nav" aria-label="สารบัญคู่มือ API">
    <a href="#api-start">เริ่มเชื่อมต่อ</a><a href="#api-sharing">ข้อมูลและ Consent</a><a href="#api-flow">ลำดับการทำงาน</a><a href="#api-auth">Authentication</a><a href="#api-renewal">Refresh token</a>
    {operations.map(({path,method,op})=><a key={op.operationId} href={`#${op.operationId}`}><b>{method.toUpperCase()}</b><span>{path.replace('/api/sso/','')}</span></a>)}
    <a href="#api-claims">Claims & Roles</a><a href="#api-errors">Errors & retry</a><a href="#api-bff">ตัวอย่าง Node.js BFF</a><a href="#api-go-live">ทดสอบก่อนใช้งาน</a>
  </nav><div className="api-docs-content">
    <section id="api-start"><h2>เริ่มเชื่อมต่อ</h2><p>สำหรับ Service ที่ผู้ดูแลอนุมัติ ใช้ BFF ของ Service เก็บ API key, PKCE verifier และ token ไว้ฝั่งเซิร์ฟเวอร์ React ติดต่อ BFF ผ่าน session cookie ของ Service</p>
      <ol><li>เพิ่ม Application และ HTTPS callback แบบเต็ม (HTTP เฉพาะ localhost)</li><li>สร้าง API key ของ Application พร้อม scope <code>identity:read</code> และ <code>token:introspect</code></li><li>สมาชิกภายในใช้ Allowlist เดิม ส่วนผู้สมัครผ่าน Service ให้ตั้งนโยบายรับสมัครหรือคำเชิญโดยไม่เพิ่ม Allowlist กลาง</li><li>สร้าง Role พื้นฐาน แล้วเพิ่มสมาชิกด้วย Admin หรือให้รับ Role หลังสมัครและอนุญาตข้อมูลสำเร็จ <button className="text-link" onClick={()=>navigate('serviceAccess')}>จัดการสิทธิ์ Service</button></li><li>ตั้งค่า persistent session store ของ BFF, HTTPS, CSRF, rate limit และตัวแปรด้านล่าง</li></ol>
      <p>นโยบายสมาชิกกำหนดข้อมูลจำเป็น การบังคับผูกเบอร์/LINE และระดับ MFA ได้แยกกัน BFF ต้องขอ scope ครอบคลุมข้อมูลจำเป็น ระบบจะพาไปทำข้อมูลให้ครบและตรวจ Consent ก่อนออก code การตรวจบัญชีไม่ใช้งานยังเป็น preview ไม่มีการลบอัตโนมัติ</p>
      {code(`SSO_ORIGIN=${window.location.origin}\nSSO_APPLICATION_ID=<application UUID>\nSSO_API_KEY=<backend secret>\nSSO_REDIRECT_URI=https://portal.example.com/auth/callback\nPORTAL_ORIGIN=https://portal.example.com`)}
      <p className="api-callout">นี่เป็น custom SSO API ไม่ใช่ OIDC provider เต็มรูปแบบ ไม่มี discovery, ID token หรือ dynamic registration รองรับ refresh token แบบหมุนใหม่ภายในอายุ MFA session เดิม โดยเชื่อมตาม Endpoint ด้านล่าง</p>
    </section>
    <section id="api-waiting"><h2>Service ที่เปิดห้องรอคิว</h2><p>Authorize อาจพา browser ไปห้องรอคิวก่อน Google/MFA ระบบยังตรวจ state, PKCE และสิทธิ์เดิมครบ การได้ตั๋วคิวไม่ใช่การยืนยันตัวตน เมื่อรอนานกว่า 5 นาทีและถึงคิว หน้ารอจะแนะนำให้กลับไปเริ่ม flow ใหม่จาก Service ใน browser เดิมภายใน 15 นาที สิทธิ์คิวเดิมจะยังอยู่ ไม่ยืดอายุ state/verifier ของ BFF</p><p>ถ้า Redis ไม่พร้อม ระบบตอบ 503 โดยไม่ข้ามคิว; 429 ให้รอตาม Retry-After โควตาต่อ IP อาจกระทบเครือข่ายร่วมกัน การจำกัดหนึ่งบัญชีต่ออุปกรณ์หรือการซื้อซ้ำต้องตรวจที่ backend ของ Service เอง</p></section>
    <section id="api-sharing"><h2>ขอข้อมูลเฉพาะที่จำเป็น พร้อม Consent</h2>
      <p>Admin เปิดข้อมูลที่ Service ขอได้ใน “แอปพลิเคชัน → ตั้งค่าข้อมูลและ Consent” แล้ว BFF ส่ง scope ใน authorize เช่น <code>identity:read profile email phone:match assurance</code> ผู้ใช้เลือกข้อมูลเสริมเองก่อนออก code ไม่เลือกไว้ล่วงหน้า และถอนการอนุญาตได้จากหน้า “ความปลอดภัย”</p>
      <div className="table-scroll"><table><thead><tr><th>Scope</th><th>ข้อมูลที่อนุมัติให้ส่ง</th></tr></thead><tbody>{[
        ['identity:read','sub, aud, roles เฉพาะ Service — จำเป็นสำหรับ login'],['profile','name, given_name, family_name, picture, department'],['email','email, email_verified'],['phone','phone_number, phone_number_verified, phone_number_verified_at'],['phone:match','ใช้ API ตรวจเบอร์ คืน matched / mismatch / unverified ไม่ส่งเบอร์จริง'],['line','line.linked, line.user_id, line.login_channel_id'],['assurance','authentication: วิธี เวลา และระดับตามนโยบาย CUSA']
      ].map(([scope,detail])=><tr key={scope}><td><code>{scope}</code></td><td>{detail}</td></tr>)}</tbody></table></div>
      <p>ตรวจ scope ที่ได้รับจริงจาก token response ข้อมูลที่ผู้ใช้ไม่อนุมัติจะไม่มี field ใน userinfo/introspection อย่าสมมติว่าจะมี email/phone เสมอ หากผู้ใช้ปฏิเสธทั้งหมด callback จะมี <code>error=access_denied</code> พร้อม state ให้ตรวจ state ก่อนและไม่วนเริ่ม login อัตโนมัติ</p>
      <p>LINE UID เทียบกันได้เฉพาะ Provider เดียวกัน; การยืนยันเบอร์พิสูจน์การถือครอง ณ เวลายืนยัน ไม่ใช่ชื่อเจ้าของซิมหรือ KYC ผล <code>unverified</code> ใช้ <code>match:null</code> ห้ามถือว่าเป็นเบอร์ที่ตรงกันหรือใช้เบอร์เพื่อรวมบัญชีอัตโนมัติ</p>
      <p>ระดับ <code>cusa:strong</code> คือ Passkey/TOTP, <code>cusa:standard</code> คือ Email/LINE และ <code>cusa:recovery</code> คือรหัสกู้คืน ข้อมูลยืนยันถูกบันทึก ณ ตอนอนุมัติ ไม่อัปเกรด Token เก่าย้อนหลังเมื่อ session ยืนยันเพิ่ม และไม่ใช่ระดับ AAL ที่รับรองตามมาตรฐานภายนอก</p>
    </section>
    <section id="api-flow"><h2>ลำดับการทำงาน</h2><ol className="api-flow"><li><strong>Browser → BFF</strong><span>เริ่ม login; สร้าง state/verifier แบบสุ่มและบันทึก session ก่อน redirect</span></li><li><strong>BFF → CUSA SSO authorize</strong><span>ส่ง client_id, callback, state, scope และ challenge S256</span></li><li><strong>CUSA SSO → Google + MFA</strong><span>ตรวจ allowlist และสิทธิ์ Service; ถ้ามี CUSA session ที่ผ่าน MFA แล้วใช้ session เดิมได้</span></li><li><strong>ผู้ใช้ → Consent</strong><span>ดูชื่อ Service วัตถุประสงค์ และเลือกข้อมูลที่จะอนุญาต ก่อนออก code</span></li><li><strong>CUSA SSO → BFF callback</strong><span>คืน code + state หรือ error; BFF ตรวจ state/อายุ flow และแลก code ด้วย verifier เดิม</span></li><li><strong>BFF → introspect</strong><span>ตรวจ active, aud, exp, roles ก่อนทุก protected operation; regenerate session ก่อนผูก token ใหม่</span></li></ol></section>
    <section id="api-auth"><h2>Authentication และอายุข้อมูล</h2><div className="table-scroll"><table><thead><tr><th>รายการ</th><th>ข้อกำหนด</th></tr></thead><tbody>
      {[['API key','X-API-Key เฉพาะ backend; ผูก Application และ scope; ไม่ส่งให้ browser'],['PKCE','S256 เท่านั้น; verifier 43–128 ตัวอักษร; code ใช้ครั้งเดียวภายใน 90 วินาที'],['Access token','Opaque 256-bit, base64url 43 ตัวอักษร; อายุสูงสุด 300 วินาที'],['Session cookie ของ BFF','HttpOnly; Secure; SameSite=Lax; Path=/; ไม่ใช้ Domain กับ __Host-'],['Renewal','ขอด้วย request_refresh_token:true ตอนแลก code; หมุน refresh token ด้วย API key ชุดเดิม ภายในอายุ MFA session เดิม'],['Logout','เรียก /revoke ด้วย scope token:revoke และลบ session/token ใน BFF ด้วย POST+CSRF; ไม่เท่ากับ logout ทุก Service หรือออกจาก Google']].map(([a,b])=><tr key={a}><th>{a}</th><td>{b}</td></tr>)}
      </tbody></table></div></section>
    <section id="api-renewal"><h2>Renewal ด้วย refresh token</h2>
      <p>เพิ่ม <code>request_refresh_token:true</code> ตอนแลก code เพื่อรับ refresh token จากนั้นส่ง <code>grant_type:refresh_token</code> และ <code>refresh_token</code> ไปยัง <code>/api/sso/token</code> ด้วย API key ชุดเดิม ทุกครั้งจะได้คู่ token ใหม่ อายุรวมไม่เกิน MFA session และ key เดิม ไม่มีการเพิ่ม scope หรือยืด MFA</p>
      <p>เก็บคู่ token ใน backend เท่านั้น และใช้ lock ร่วมกันทุก BFF instance ให้ refresh ได้ครั้งละหนึ่งคำขอต่อชุด บันทึกคู่ใหม่แบบ atomic ก่อนปล่อย lock ใช้ token เก่าซ้ำจะยกเลิกทั้งชุดรวม access token; timeout หรือผลไม่แน่ชัดให้เริ่ม authorize ใหม่ ไม่ retry ค่าเดิม ไม่มี grace period</p>
      <p>ถอน Consent, เปลี่ยนสิทธิ์, revoke key หรือ logout ทำให้ใช้ refresh ต่อไม่ได้ ตรวจ introspection ของ access token ใหม่ก่อนอนุญาตงานเสมอ การ revoke ยังมีขอบเขต cache สูงสุด 5 วินาทีตามเดิม ตัวอย่าง BFF ด้านล่างยังเป็นแบบ access token อย่างเดียว</p>
    </section>
    <label className="api-search"><Search size={18}/><input aria-label="ค้นหา Endpoint" placeholder="ค้นหา Endpoint เช่น introspect" value={search} onChange={e=>setSearch(e.target.value)}/></label>
    {selected.map(({path,method,op})=>{
      const body=op.requestBody?resolve(Object.values(op.requestBody.content)[0].schema):undefined;
      const variants=body?.oneOf?.map(resolve)??(body?[body]:[]);
      const fields=[...(op.parameters??[]),...variants.flatMap(variant=>Object.entries(variant.properties??{}).map(([name,schema])=>({name,
        in:body?.oneOf?`body · ${variant.properties?.grant_type?.enum?.[0]??''}`:'body',required:variant.required?.includes(name),description:schema.description,schema})))];
      const scheme=Object.keys(op.security?.[0]??{})[0];
      return <section className="api-endpoint" id={op.operationId} key={op.operationId}><div className="api-operation"><span className={`http-method ${method}`}>{method.toUpperCase()}</span><code>{path}</code></div><h2>{op.summary}</h2><p>{op.description}</p>
        <p className="api-auth-note">{scheme==='ApiKey'?'Header: X-API-Key · Content-Type: application/json':scheme==='BearerToken'?'Header: Authorization: Bearer <ACCESS_TOKEN>':scheme==='CookieSession'?'CUSA session cookie (HttpOnly) · คำขอเปลี่ยนแปลงต้องมี Origin และ X-CSRF-Token':'ไม่ใช้ API key; authorize ตรวจ CUSA session ที่ผ่าน MFA'}</p>
        {fields.length>0&&<><h3>{body?'Request body / Parameters':'Parameters'}</h3><div className="table-scroll"><table><thead><tr><th>ชื่อ / ที่ส่ง</th><th>ชนิด</th><th>คำอธิบาย</th></tr></thead><tbody>{fields.map(f=><tr key={`${f.in}-${f.name}`}><td><code>{f.name}</code><small>{f.in} · {f.required?'required':'optional'}</small></td><td>{Array.isArray(f.schema.type)?f.schema.type.join(' | '):f.schema.type}{f.schema.format&&<small>{f.schema.format}</small>}</td><td>{f.description}{f.schema.enum&&<small>ค่า: {f.schema.enum.join(', ')}</small>}{f.schema.pattern&&<small className="api-pattern">{f.schema.pattern}</small>}</td></tr>)}</tbody></table></div></>}
        {op['x-codeSamples']?.map(sample=><div key={sample.lang}><h3>{sample.lang} · ตัวอย่างค่าจำลอง</h3>{code(sample.source)}</div>)}
        <h3>Responses</h3>{Object.entries(op.responses).map(([status,response])=>{const content=response.content?.['application/json'];const samples=content?.examples?Object.entries(content.examples).map(([label,v])=>({label,value:v.value})):content?.example?[{label:'Example',value:content.example}]:[];return <details className="api-response" key={status} open={status==='200'||status==='303'||status==='204'}><summary><b>{status}</b> {response.description}</summary>{samples.map(sample=><div key={sample.label}><small>{sample.label}</small>{code(JSON.stringify(sample.value,null,2))}</div>)}</details>;})}
      </section>;
    })}
    {!selected.length&&<p role="status">ไม่พบ Endpoint ที่ตรงกับคำค้น</p>}
    <section id="api-claims"><h2>Claims และ Role ของ Service</h2><div className="table-scroll"><table><thead><tr><th>Claim</th><th>ความหมาย</th></tr></thead><tbody>{Object.entries(resolve({$ref:'#/components/schemas/ActiveToken'}).properties??{}).map(([name,s])=><tr key={name}><td><code>{name}</code></td><td>{s.description|| (name==='active'?'ต้องเป็น true จึงพิจารณาสิทธิ์ต่อ':'สถานะของ token')}</td></tr>)}</tbody></table></div><p>ตรวจ Role ใน backend ของ Service เสมอ; ซ่อนปุ่มใน React อย่างเดียวไม่ใช่ authorization การแก้สมาชิกหรือ Role ยกเลิก token ของ Service นั้น ส่วน Role ของ Service ไม่ให้สิทธิ์ผู้ดูแล CUSA SSO</p></section>
    <section id="api-errors"><h2>Errors, quota และ retry</h2><div className="table-scroll"><table><thead><tr><th>HTTP</th><th>Code</th><th>การจัดการ</th></tr></thead><tbody>{errors.map(([status,error,help])=><tr key={error}><td>{status}</td><td><code>{error}</code></td><td>{help}</td></tr>)}</tbody></table></div><p>โควตา SSO token + introspect รวมกัน: 3,000/min/Application และ 1,500/min/API key พร้อม coarse IP limit 12,000/min/instance อย่าวน retry invalid_client หรือ invalid_grant ด้วยค่าเดิม</p><p>Introspection cache ที่ CUSA สูงสุด 5 วินาทีและไม่เกิน exp; ไม่เพิ่ม positive cache ที่ BFF หากต้องการขอบเขต revoke นี้ หาก SSO ติดต่อไม่ได้ให้ตอบ 503 และปฏิเสธ operation ใช้ NTP ให้เวลาตรงกัน ไม่ใช้ grace period ต่ออายุ token</p><p>CORS เปิดเฉพาะ userinfo จาก origin ของ callback ที่ลงทะเบียน token/introspect เป็น server-to-server ไม่มี CORS สำหรับเก็บ API key ใน React</p></section>
    <section id="api-bff"><h2>ตัวอย่าง Node.js BFF</h2><p>ตัวอย่าง flow สำหรับ Express 5 ใช้ร่วมกับ persistent server-side session store และ middleware ของ Service ที่มีอยู่ ต้องตั้ง Secure cookie, CSRF, rate limit และ error handler ก่อนใช้งาน ไม่ใช้ MemoryStore บน production</p>{code(bff)}<p>Callback ไม่ควรมี analytics/third-party scripts และ access log ต้องไม่บันทึก query, code, verifier หรือ token การแลก code เดียวพร้อมกันสำเร็จได้ครั้งเดียว; หากมีหลาย login พร้อมกันควรเก็บ flow แยกตาม state ใน persistent store และ consume แบบ atomic</p></section>
    <section id="api-go-live"><h2>ทดสอบก่อนเปิดใช้งาน</h2><ul><li>Login ปกติ, email OTP/TOTP, ผู้ใช้ไม่มี Role และผู้ใช้ถูกถอน allowlist</li><li>state ผิด, callback ต่างแม้แต่ slash, verifier ผิด, code ซ้ำ/หมดอายุ</li><li>key ของ Application อื่น, key หมดอายุ/ถูก revoke/ขาด scope</li><li>token หมดอายุ, session ถูก revoke, Role ถูกเปลี่ยน และ API กลาง timeout</li><li>CSRF ของ BFF, session regeneration, cookie flags และไม่พบ secret ใน browser storage/logs</li><li>ยิง load ตามจำนวนผู้ใช้เป้าหมาย ตรวจ Retry-After, pool wait และ outbox backlog</li></ul><p>ดาวน์โหลด OpenAPI ไปเปิดในเครื่องมือของทีมได้ ตัวอย่างทุกชุดเป็น placeholder ต้องแทนค่าที่ backend และเก็บ credentials ใน secret manager</p></section>
  </div></div></>;
}
