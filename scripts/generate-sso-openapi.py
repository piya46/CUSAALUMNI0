"""Generate the public SSO contract; no credentials or deployment-specific values."""
import json
from pathlib import Path
ref=lambda name:{'$ref':f'#/components/schemas/{name}'}
string=lambda description,**extra:{'type':'string','description':description,**extra}
opaque=string('Opaque credential: CSPRNG 32 bytes, base64url without padding',pattern='^[A-Za-z0-9_-]{43}$')
params=[
 ('response_type',{'type':'string','enum':['code']},'Authorization Code grant เท่านั้น'),
 ('client_id',{'type':'string','format':'uuid'},'Application ID จากหน้า Applications ไม่ใช่ Google Client ID'),
 ('redirect_uri',{'type':'string','format':'uri','maxLength':2048},'Callback ต้องตรงกับที่ลงทะเบียนทุกตัวอักษร'),
 ('state',{'type':'string','pattern':'^[A-Za-z0-9_-]{32,128}$'},'CSPRNG อย่างน้อย 32 bytes ผูกกับ BFF session และใช้ครั้งเดียว'),
 ('code_challenge',opaque,'BASE64URL(SHA256(verifier)) ไม่มี = padding'),
 ('code_challenge_method',{'type':'string','enum':['S256']},'ไม่รองรับ plain'),
]
parameters=[{'name':n,'in':'query','required':True,'schema':s,'description':d} for n,s,d in params]
error={'type':'object','required':['error'],'properties':{'error':string('ข้อความที่ปลอดภัยสำหรับแสดงผล'),'code':string('Machine-readable error code; case-sensitive'),'requestId':string('Server-generated correlation UUID ถ้ามี',format='uuid')}}
responses={str(status):{'description':description,'content':{'application/json':{'schema':ref('Error'),'example':{'error':message,'code':code}}}} for status,description,message,code in [
 (400,'Validation / invalid grant','Invalid request parameters','invalid_request'),
 (401,'Missing, expired or revoked credential','Invalid or expired API key','invalid_client'),
 (403,'Insufficient scope / CORS / account access','API key does not permit this operation','insufficient_scope'),
 (429,'Quota exceeded; respect Retry-After','Service request quota exceeded','RATE_LIMITED'),
 (503,'Dependency or audit unavailable; fail closed','Service unavailable','AUDIT_UNAVAILABLE'),
 (500,'Unexpected server failure','Unable to process request','INTERNAL_ERROR')]}
responses['429']['headers']={'Retry-After':{'description':'เวลารอเป็นวินาที ห้าม retry รัว','schema':{'type':'integer','minimum':1}}}
def jsonresponse(schema,example,description='Success'):
 return {'description':description,'content':{'application/json':{'schema':schema,'example':example}}}
def body(schema): return {'required':True,'content':{'application/json':{'schema':schema}}}
def obj(properties,required=None):return {'type':'object','properties':properties,'required':required or list(properties),'additionalProperties':False}
claims={
 'sub':string('รหัสผู้ใช้ถาวร ใช้เป็น foreign key ของระบบปลายทาง',format='uuid'),
 'email':string('อีเมลที่ยืนยันแล้ว อาจเปลี่ยนได้ ไม่ใช่ primary user ID',format='email'),
 'name':string('ชื่อแสดงผล'), 'given_name':string('ชื่อจริง อาจเป็นสตริงว่าง'), 'family_name':string('นามสกุล อาจเป็นสตริงว่าง'),
 'department':string('หน่วยงานของผู้ใช้เฉพาะ Service นี้ อาจว่าง'),
 'roles':{'type':'array','description':'รหัส Role ที่ได้รับใน Service นี้ ไม่ใช่สิทธิ์ CUSA Admin','items':{'type':'string'}},
 'aud':string('Application ID ต้องเท่ากับ SSO_APPLICATION_ID ของระบบคุณ',format='uuid')}
identity={'sub':'11111111-1111-4111-8111-111111111111','email':'member@example.com','name':'Example Member','given_name':'Example','family_name':'Member','department':'ฝ่ายสมาชิก','roles':['viewer','approver'],'aud':'22222222-2222-4222-8222-222222222222'}
active={**identity,'active':True,'exp':2000000000,'scope':'identity:read'}
schemas={'Error':error,'Profile':obj({**claims,'email_verified':{'type':'boolean','const':True}}),'ActiveToken':obj({**claims,'active':{'type':'boolean','const':True},'exp':{'type':'integer','description':'Unix seconds; min(token, session, API-key expiry)'},'scope':string('Granted scope')}),'InactiveToken':obj({'active':{'type':'boolean','const':False}}),
 'ExchangeRequest':obj({'grant_type':{'type':'string','enum':['authorization_code']},'code':opaque,'redirect_uri':string('Callback เดียวกับ authorize',minLength=1,maxLength=2048),'code_verifier':string('PKCE verifier เดิม ห้ามสร้างใหม่ที่ callback',pattern='^[A-Za-z0-9._~-]{43,128}$')}),
 'TokenResponse':obj({'access_token':opaque,'token_type':{'type':'string','enum':['Bearer']},'expires_in':{'type':'integer','const':300,'description':'อายุสูงสุด; session ต้นทางอาจหมดอายุก่อน'},'scope':{'type':'string','enum':['identity:read']}}),
 'IntrospectionRequest':obj({'token':string('Opaque access token',minLength=1,maxLength=512)}),
 'LoginContext':obj({'application':obj({'name':string('ชื่อที่ลงทะเบียน'),'origin':string('Origin จาก callback',format='uri')}),'returnTo':string('Internal authorize path สำหรับ View ของ CUSA SSO')})}
authresponse={'303':{'description':'ส่งไป /login เมื่อยังไม่ผ่าน MFA; สำเร็จส่ง callback?code=...&state=...; account ไม่มีสิทธิ์ไป /login?auth=access_denied','headers':{'Location':{'schema':{'type':'string','format':'uri-reference'}}}},**responses}
paths={
 '/api/sso/authorize':{'get':{'operationId':'authorize','summary':'เริ่มเข้าสู่ระบบ Service','description':'Browser navigation หลัง BFF สร้างและเก็บ state/verifier ใน server session; code มีอายุ 90 วินาที ใช้ครั้งเดียว ต้องมีสมาชิกและ Role ของ Service','tags':['Authorization'],'security':[],'parameters':parameters,'responses':authresponse}},
 '/api/sso/login-context':{'get':{'operationId':'loginContext','summary':'อ่านบริบทหน้าเข้าสู่ระบบ','description':'ใช้โดยหน้า Login ของ CUSA SSO; ผู้เชื่อมต่อทั่วไปเริ่มที่ authorize ได้เลย ไม่ออก token/code','tags':['Authorization'],'security':[],'parameters':parameters,'responses':{'200':jsonresponse(ref('LoginContext'),{'application':{'name':'Member Portal','origin':'https://portal.example.com'},'returnTo':'/api/sso/authorize?...'}),**responses}}},
 '/api/sso/token':{'post':{'operationId':'exchangeCode','summary':'แลก authorization code','description':'เรียกจาก BFF เท่านั้น ต้องมี identity:read และ callback/verifier เดิม ไม่รองรับ refresh_token/password/client_credentials; อย่า retry code เดิมเมื่อไม่ทราบผลการแลก','tags':['Tokens'],'security':[{'ApiKey':[]}],'requestBody':body(ref('ExchangeRequest')),'responses':{'200':jsonresponse(ref('TokenResponse'),{'access_token':'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','token_type':'Bearer','expires_in':300,'scope':'identity:read'}),**responses}}},
 '/api/sso/introspect':{'post':{'operationId':'introspectToken','summary':'ตรวจ token ก่อน protected operation','description':'ต้องมี token:introspect ตรวจได้เฉพาะ token ของ application เดียวกัน HTTP 200 ไม่เท่ากับ authenticated ต้องตรวจ active, aud, exp และ roles; identity cache สูงสุด 5 วินาที','tags':['Tokens'],'security':[{'ApiKey':[]}],'requestBody':body(ref('IntrospectionRequest')),'responses':{'200':{'description':'Active identity หรือ inactive ไม่มีข้อมูลผู้ใช้','content':{'application/json':{'schema':{'oneOf':[ref('ActiveToken'),ref('InactiveToken')]},'examples':{'active':{'value':active},'inactive':{'value':{'active':False}}}}}},**responses}}},
 '/api/sso/userinfo':{
 'get':{'operationId':'userInfo','summary':'อ่านข้อมูลโปรไฟล์ของ token','description':'Bearer access token; หากส่ง Origin ต้องตรงกับ origin ของ application เจ้าของ token ไม่มี wildcard/credentials CORS ระบบ BFF ควรเรียกผ่าน backend','tags':['Identity'],'security':[{'BearerToken':[]}],'parameters':[{'name':'Origin','in':'header','required':False,'schema':{'type':'string','format':'uri'},'description':'Browser origin; ต้องตรงกับ origin ของ registered callback'}],'responses':{'200':jsonresponse(ref('Profile'),{**identity,'email_verified':True}),**responses,'401':jsonresponse(ref('Error'),{'error':'Valid, active bearer access token required','code':'invalid_token'},'Invalid/expired access token; WWW-Authenticate: Bearer')}},
 'options':{'operationId':'userInfoPreflight','summary':'CORS preflight ของ userinfo','description':'อนุญาต GET และ Authorization header จาก registered origin เท่านั้น','tags':['Identity'],'security':[],'parameters':[{'name':n,'in':'header','required':n!='Access-Control-Request-Headers','schema':{'type':'string'},'description':d} for n,d in [('Origin','Origin ของ callback ที่ลงทะเบียน'),('Access-Control-Request-Method','GET'),('Access-Control-Request-Headers','Authorization ถ้ามี')]],'responses':{'204':{'description':'Preflight accepted; Access-Control-Allow-Origin เป็น origin ที่ตรวจแล้ว'},**responses}}}}
samples={
 'exchangeCode':'''curl --request POST "$SSO_ORIGIN/api/sso/token" \\\n  --header 'Content-Type: application/json' \\\n  --header "X-API-Key: $SSO_API_KEY" \\\n  --data '{"grant_type":"authorization_code","code":"<CODE>","redirect_uri":"https://portal.example.com/auth/callback","code_verifier":"<ORIGINAL_VERIFIER>"}' ''',
 'introspectToken':'''curl --request POST "$SSO_ORIGIN/api/sso/introspect" \\\n  --header 'Content-Type: application/json' \\\n  --header "X-API-Key: $SSO_API_KEY" \\\n  --data '{"token":"<ACCESS_TOKEN>"}' ''',
 'userInfo':'''curl "$SSO_ORIGIN/api/sso/userinfo" \\\n  --header "Authorization: Bearer $ACCESS_TOKEN"'''}
for item in paths.values():
 for operation in item.values():
  if operation['operationId'] in samples: operation['x-codeSamples']=[{'lang':'curl','source':samples[operation['operationId']].strip()}]
spec={'openapi':'3.1.0','info':{'title':'CUSA SSO API','version':'1.1.0','description':'Custom first-party SSO: Authorization Code + PKCE S256, opaque tokens, application-scoped roles. Not a full OAuth/OIDC provider; no discovery, ID token, refresh token or dynamic registration. Examples are placeholders; never paste production secrets into browser documentation.'},'servers':[{'url':'/','description':'Same origin as this documentation; production uses HTTPS'}],'tags':[{'name':n} for n in ['Authorization','Tokens','Identity']],'paths':paths,'components':{'securitySchemes':{'ApiKey':{'type':'apiKey','in':'header','name':'X-API-Key','description':'Application-bound backend secret. Scope identity:read or token:introspect as required.'},'BearerToken':{'type':'http','scheme':'bearer','bearerFormat':'opaque'}},'schemas':schemas}}
root=Path(__file__).resolve().parents[1]
(root/'web/public/openapi.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2)+'\n')
