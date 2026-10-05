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
 (404,'Resource not found in the permitted scope','Resource not found','NOT_FOUND'),
 (409,'Policy version or activity identifier conflict','Reload the current policy or use the correct event identifier','CONFLICT'),
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
active={**identity,'active':True,'exp':2000000000,'scope':'identity:read profile email'}
schemas={'Error':error,'Profile':obj({**claims,'email_verified':{'type':'boolean','const':True}}),'ActiveToken':obj({**claims,'active':{'type':'boolean','const':True},'exp':{'type':'integer','description':'Unix seconds; min(token, session, API-key expiry)'},'scope':string('Granted scope')}),'InactiveToken':obj({'active':{'type':'boolean','const':False}}),
 'ExchangeRequest':obj({'grant_type':{'type':'string','enum':['authorization_code']},'code':opaque,'redirect_uri':string('Callback เดียวกับ authorize',minLength=1,maxLength=2048),'code_verifier':string('PKCE verifier เดิม ห้ามสร้างใหม่ที่ callback',pattern='^[A-Za-z0-9._~-]{43,128}$')}),
 'TokenResponse':obj({'access_token':opaque,'token_type':{'type':'string','enum':['Bearer']},'expires_in':{'type':'integer','const':300,'description':'อายุสูงสุด; session ต้นทางอาจหมดอายุก่อน'},'scope':{'type':'string','enum':['identity:read']}}),
 'IntrospectionRequest':obj({'token':string('Opaque access token',minLength=1,maxLength=512)}),
 'LoginContext':obj({'application':obj({'name':string('ชื่อที่ลงทะเบียน'),'origin':string('Origin จาก callback',format='uri')}),'returnTo':string('Internal authorize path สำหรับ View ของ CUSA SSO')})}
authresponse={'303':{'description':'ส่งไป /login เมื่อยังไม่ผ่าน MFA; ผ่าน MFA แล้วส่งไป /consent; ออก code เฉพาะหลัง POST อนุมัติ Consent; account ไม่มีสิทธิ์ไป /login?auth=access_denied','headers':{'Location':{'schema':{'type':'string','format':'uri-reference'}}}},**responses}
paths={
 '/api/sso/authorize':{'get':{'operationId':'authorize','summary':'เริ่มเข้าสู่ระบบ Service','description':'Browser navigation หลัง BFF สร้างและเก็บ state/verifier ใน server session; code มีอายุ 90 วินาที ใช้ครั้งเดียว ต้องมีสมาชิกและ Role ของ Service และอนุมัติรายการข้อมูลก่อนออก code','tags':['Authorization'],'security':[],'parameters':parameters,'responses':authresponse}},
 '/api/sso/login-context':{'get':{'operationId':'loginContext','summary':'อ่านบริบทหน้าเข้าสู่ระบบ','description':'ใช้โดยหน้า Login ของ CUSA SSO; ผู้เชื่อมต่อทั่วไปเริ่มที่ authorize ได้เลย ไม่ออก token/code','tags':['Authorization'],'security':[],'parameters':parameters,'responses':{'200':jsonresponse(ref('LoginContext'),{'application':{'name':'Member Portal','origin':'https://portal.example.com'},'returnTo':'/api/sso/authorize?...'}),**responses}}},
 '/api/sso/token':{'post':{'operationId':'exchangeCode','summary':'แลก authorization code','description':'เรียกจาก BFF เท่านั้น ต้องมี identity:read และ callback/verifier เดิม ไม่รองรับ refresh_token/password/client_credentials; อย่า retry code เดิมเมื่อไม่ทราบผลการแลก','tags':['Tokens'],'security':[{'ApiKey':[]}],'requestBody':body(ref('ExchangeRequest')),'responses':{'200':jsonresponse(ref('TokenResponse'),{'access_token':'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','token_type':'Bearer','expires_in':300,'scope':'identity:read profile email'}),**responses}}},
 '/api/sso/introspect':{'post':{'operationId':'introspectToken','summary':'ตรวจ token ก่อน protected operation','description':'ต้องมี token:introspect ตรวจได้เฉพาะ token ของ application เดียวกัน HTTP 200 ไม่เท่ากับ authenticated ต้องตรวจ active, aud, exp และ roles; identity cache สูงสุด 5 วินาที','tags':['Tokens'],'security':[{'ApiKey':[]}],'requestBody':body(ref('IntrospectionRequest')),'responses':{'200':{'description':'Active identity หรือ inactive ไม่มีข้อมูลผู้ใช้','content':{'application/json':{'schema':{'oneOf':[ref('ActiveToken'),ref('InactiveToken')]},'examples':{'active':{'value':active},'inactive':{'value':{'active':False}}}}}},**responses}}},
 '/api/sso/userinfo':{
 'get':{'operationId':'userInfo','summary':'อ่านข้อมูลโปรไฟล์ของ token','description':'Bearer access token; หากส่ง Origin ต้องตรงกับ origin ของ application เจ้าของ token ไม่มี wildcard/credentials CORS ระบบ BFF ควรเรียกผ่าน backend','tags':['Identity'],'security':[{'BearerToken':[]}],'parameters':[{'name':'Origin','in':'header','required':False,'schema':{'type':'string','format':'uri'},'description':'Browser origin; ต้องตรงกับ origin ของ registered callback'}],'responses':{'200':jsonresponse(ref('Profile'),{**identity,'email_verified':True}),**responses,'401':jsonresponse(ref('Error'),{'error':'Valid, active bearer access token required','code':'invalid_token'},'Invalid/expired access token; WWW-Authenticate: Bearer')}},
 'options':{'operationId':'userInfoPreflight','summary':'CORS preflight ของ userinfo','description':'อนุญาต GET และ Authorization header จาก registered origin เท่านั้น','tags':['Identity'],'security':[],'parameters':[{'name':n,'in':'header','required':n!='Access-Control-Request-Headers','schema':{'type':'string'},'description':d} for n,d in [('Origin','Origin ของ callback ที่ลงทะเบียน'),('Access-Control-Request-Method','GET'),('Access-Control-Request-Headers','Authorization ถ้ามี')]],'responses':{'204':{'description':'Preflight accepted; Access-Control-Allow-Origin เป็น origin ที่ตรวจแล้ว'},**responses}}}}
samples={
 'exchangeCode':'''curl --request POST "$SSO_ORIGIN/api/sso/token" \\\n  --header 'Content-Type: application/json' \\\n  --header "X-API-Key: $SSO_API_KEY" \\\n  --data '{"grant_type":"authorization_code","code":"<CODE>","redirect_uri":"https://portal.example.com/auth/callback","code_verifier":"<ORIGINAL_VERIFIER>"}' ''',
 'introspectToken':'''curl --request POST "$SSO_ORIGIN/api/sso/introspect" \\\n  --header 'Content-Type: application/json' \\\n  --header "X-API-Key: $SSO_API_KEY" \\\n  --data '{"token":"<ACCESS_TOKEN>"}' ''',
 'userInfo':'''curl "$SSO_ORIGIN/api/sso/userinfo" \\\n  --header "Authorization: Bearer $ACCESS_TOKEN"'''}
paths['/api/sso/revoke']={'post':{'operationId':'revokeServiceSession','summary':'ถอน Token ของเซสชันเฉพาะ Service ของคุณ','description':'BFF ใช้ API key ที่มี token:revoke ส่ง access token ที่ถืออยู่ ระบบถอน access tokens และ authorization codes ของ session เดียวกันเฉพาะ application ของคีย์ ไม่ลบ SSO session ไม่กระทบ Service อื่น ไม่ห้าม login ใหม่ Unknown/cross-app token ตอบ ok เหมือนกัน; cache เดิมอาจมีผลไม่เกิน 5 วินาที ต้องทำลาย BFF session และล้าง cache ของตัวเองด้วย','tags':['Tokens'],'security':[{'ApiKey':[]}],'requestBody':body(ref('IntrospectionRequest')),'responses':{'200':jsonresponse(obj({'ok':{'type':'boolean','const':True}}),{'ok':True}),**responses}}}
paths['/api/sso/authorize']['get']['description']+='; Service ที่เปิดคิวอาจส่งไป /waiting ก่อน Google/MFA ห้ามเพิ่มพารามิเตอร์นอกสัญญา คิวไม่แทนการตรวจสิทธิ์หรือ PKCE'
authresponse['303']['description']+='; /waiting เมื่อ Service เปิดคิวและยังไม่มีสิทธิ์ผ่านคิว'
samples['revokeServiceSession']=samples['introspectToken'].replace('/api/sso/introspect','/api/sso/revoke')
for item in paths.values():
 for operation in item.values():
  if operation['operationId'] in samples: operation['x-codeSamples']=[{'lang':'curl','source':samples[operation['operationId']].strip()}]
# Per-service sharing policy and explicit consent (migration 008).
claim_scopes=['identity:read','profile','email','phone','phone:match','line','assurance']
parameters.append({'name':'scope','in':'query','required':False,'schema':{'type':'string','default':'identity:read profile email','maxLength':255},'description':'Space-separated requested claim scopes. Must include identity:read, be unique, and be permitted by the registered service policy. User may decline optional scopes.'})
claims.update({
 'scope':string('Scopes actually approved; check for missing requested scopes'),
 'email_verified':{'type':'boolean','const':True},
 'picture':{'type':['string','null'],'description':'HTTPS profile image URL; profile scope only'},
 'phone_number':string('Verified E.164 phone; phone scope only'),
 'phone_number_verified':{'type':'boolean','description':'Proof of control at verification time, not SIM registration/KYC'},
 'phone_number_verified_at':{'type':'integer','description':'Unix seconds; phone scope, only when verified'},
 'line':obj({'linked':{'type':'boolean'},'user_id':string('LINE UID in the configured LINE Provider'),'login_channel_id':string('Public LINE Login channel ID; not a Provider ID')},['linked']),
 'authentication':obj({'primary_method':{'type':'string','enum':['google']},'second_step_method':{'type':'string','enum':['email','totp','passkey','line','recovery']},'verified_at':{'type':'integer','description':'Unix seconds of the verified second step at consent approval'},'assurance':{'type':'string','enum':['cusa:standard','cusa:strong','cusa:recovery']},'phishing_resistant':{'type':'boolean','description':'Whether this second step was a user-verified Passkey; not a certification of the whole account'}})
})
schemas['Profile']=obj(claims,['sub','aud','roles','scope'])
schemas['ActiveToken']=obj({**claims,'active':{'type':'boolean','const':True},'exp':{'type':'integer','description':'Unix seconds; min(token, session, API-key expiry)'}},['sub','aud','roles','scope','active','exp'])
schemas['TokenResponse']['properties']['scope']=string('Space-separated scopes actually approved by the user')
paths['/api/sso/userinfo']['get']['responses']['200']=jsonresponse(ref('Profile'),{**identity,'email_verified':True,'scope':'identity:read profile email','picture':None})
paths['/api/sso/userinfo']['get']['description']+=' Returns only consented claims. Evidence, Google/LINE access tokens, phone hashes and MFA secrets are never returned.'
paths['/api/sso/phone-match']={'post':{'operationId':'matchPhone','summary':'ตรวจเบอร์ที่ระบบลูกได้รับว่าตรงกับบัญชีนี้หรือไม่','description':'Server-to-server only. Requires application API key with identity:read plus an active token consented for phone:match in the same application. Accepts Thai mobile or E.164. Up to 5 attempts/token/application/minute, plus service quotas. No arbitrary user lookup; response never includes phone number. No cache. Unverified returns match:null. Mismatch does not establish fraud or justify merging accounts.','tags':['Identity'],'security':[{'ApiKey':[]}],'requestBody':body(obj({'token':opaque,'phone_number':string('Phone submitted to your own service; never put in query string',maxLength=40)})),'responses':{'200':jsonresponse(obj({'status':{'type':'string','enum':['matched','mismatch','unverified']},'match':{'type':['boolean','null']},'phone_number_verified':{'type':'boolean'},'phone_number_verified_at':{'type':'integer'}},['status','match','phone_number_verified']),{'status':'matched','match':True,'phone_number_verified':True,'phone_number_verified_at':2000000000}),**responses}}}
scope_list={'type':'array','maxItems':7,'uniqueItems':True,'items':{'type':'string','enum':claim_scopes}}
schemas['ConsentContext']=obj({'application':obj({'name':string('Registered service name'),'origin':string('Registered callback origin')}),'purpose':string('Purpose configured by the administrator'),'noticeVersion':string('Consent text version'),'policyVersion':{'type':'integer'},'scopes':{'type':'array','items':obj({'scope':{'type':'string','enum':claim_scopes},'required':{'type':'boolean'},'title':string('Field group label'),'detail':string('Disclosure explanation')})}})
schemas['SharingPolicy']=obj({'scopes':scope_list,'purpose':string('Concrete purpose shown to the user',minLength=10,maxLength=500)})
read_security=[{'CookieSession':[]}]
write_security=[{'CookieSession':[],'CsrfToken':[]}]
consent_param={'name':'request','in':'query','required':True,'schema':opaque,'description':'Opaque request from authorize, bound to the current full CUSA session; expires in 10 minutes'}
def operation(name,summary,security,**extra):return {'operationId':name,'summary':summary,'description':'CUSA first-party UI endpoint; full session required. Mutations require exact Origin and CSRF header. Never call from the service browser.','tags':['Consent'],'security':security,**extra}
paths['/api/sso/consent']={
 'get':operation('readConsent','อ่านคำขออนุญาตข้อมูล',read_security,parameters=[consent_param],responses={'200':{'description':'Registered recipient, purpose, policy version and requested scopes','content':{'application/json':{'schema':ref('ConsentContext')}}},**responses}),
 'post':operation('decideConsent','อนุมัติหรือปฏิเสธการแชร์ข้อมูล',write_security,requestBody=body(obj({'request':opaque,'approved':{'type':'boolean'},'scopes':scope_list})),responses={'200':jsonresponse(obj({'redirectTo':string('Validated callback with code/state or error=access_denied/state')}),{'redirectTo':'https://portal.example.com/callback?error=access_denied&state=<STATE>'}),**responses})}
paths['/api/sso/consent']['post']['description']+=' Approval must include identity:read and only requested scopes. Denial must send scopes:[]. Decision is one-use, atomic with code issuance and audit. No token before consent.'
paths['/api/sso/consents']={'get':operation('listConsents','ดูการอนุญาตล่าสุดของตนเอง',read_security,responses={'200':jsonresponse(obj({'consents':{'type':'array','maxItems':100,'items':obj({'id':string('Consent ID',format='uuid'),'name':string('Service name'),'scope':string('Approved scopes'),'approvedAt':string('Approval time',format='date-time')})}}),{'consents':[]}),**responses})}
paths['/api/sso/consents/{id}']={'delete':operation('revokeConsent','ถอนการอนุญาตของตนเอง',write_security,parameters=[{'name':'id','in':'path','required':True,'schema':{'type':'string','format':'uuid'}}],responses={'200':jsonresponse(obj({'ok':{'type':'boolean','const':True}}),{'ok':True}),**responses})}
paths['/api/sso/consents/{id}']['delete']['description']+=' Revokes the grant behind the associated code/tokens; introspection cache delay at most 5 seconds. Does not erase copies/local sessions held by the service.'
paths['/api/admin/applications/{id}/sharing']={
 'get':operation('getSharingPolicy','ดูขอบเขตข้อมูลสูงสุดของ Service',read_security,parameters=[{'name':'id','in':'path','required':True,'schema':{'type':'string','format':'uuid'}}],responses={'200':jsonresponse(obj({**schemas['SharingPolicy']['properties'],'version':{'type':'integer'}}),{'scopes':['identity:read','profile','email'],'purpose':'เข้าสู่ระบบและแสดงข้อมูลบัญชีใน Service นี้','version':1}),**responses}),
 'put':operation('saveSharingPolicy','ตั้งค่าขอบเขตข้อมูลและวัตถุประสงค์',write_security,parameters=[{'name':'id','in':'path','required':True,'schema':{'type':'string','format':'uuid'}}],requestBody=body(ref('SharingPolicy')),responses={'200':jsonresponse(obj({'ok':{'type':'boolean','const':True}}),{'ok':True}),**responses})}
for op in paths['/api/admin/applications/{id}/sharing'].values():op['description']+=' Admin only. PUT requires fresh Passkey/TOTP and increments policy version, invalidating old requests/grants/tokens (cache bound applies). Scopes must include identity:read. Extra sensitive scopes are disabled by default.'
# Service membership policies and lifecycle review (009).
schemas['LoginContext']['properties']['registration']={'type':'string','enum':['closed','invite','open']}
schemas['AccessPolicy']=obj({
 'registration':{'type':'string','enum':['closed','invite','open']},
 'defaultRoleId':{'type':['string','null'],'format':'uuid'},
 'requirePhone':{'type':'boolean'},'requireLine':{'type':'boolean'},
 'minimumMfa':{'type':'string','enum':['standard','strong']},'requiredScopes':scope_list,
 'registrationLimit':{'type':'integer','minimum':1,'maximum':100000},
 'pendingDays':{'type':'integer','minimum':1,'maximum':30},
 'inactiveDays':{'type':['integer','null'],'minimum':30,'maximum':3650},
 'noticeDays':{'type':'integer','minimum':7,'maximum':90},
 'recoveryDays':{'type':'integer','minimum':7,'maximum':90}})
policy_output=obj({**schemas['AccessPolicy']['properties'],'version':{'type':'integer'},'lifecycleMode':{'const':'preview'}})
policy_input=obj({**schemas['AccessPolicy']['properties'],'expectedVersion':{'type':'integer','minimum':1}})
app_parameter={'name':'applicationId','in':'path','required':True,'schema':{'type':'string','format':'uuid'}}
def data_response(schema,description): return {'200':{'description':description,'content':{'application/json':{'schema':schema}}},**responses}
paths['/api/admin/applications/{applicationId}/access-policy']={
 'get':operation('getAccessPolicy','Read service account policy',read_security,parameters=[app_parameter],responses=data_response(policy_output,'Current policy; lifecycle is review-only')),
 'put':operation('setAccessPolicy','Set service account policy',write_security,parameters=[app_parameter],requestBody=body(policy_input),responses=data_response(policy_output,'Fresh strong admin MFA required; increments policy version and invalidates existing service grants'))}
invitation_email=string('Verified Google email invited to this service',format='email',maxLength=254)
paths['/api/admin/applications/{applicationId}/invitations']={
 'get':operation('listInvitations','List service invitations',read_security,parameters=[app_parameter,{'name':'page','in':'query','schema':{'type':'integer','minimum':1,'maximum':10000,'default':1}},{'name':'limit','in':'query','schema':{'type':'integer','minimum':1,'maximum':100,'default':20}}],responses=data_response(obj({'invitations':{'type':'array','items':obj({'email':invitation_email,'expiresAt':{'type':'string','format':'date-time'}})},'hasMore':{'type':'boolean'},'page':{'type':'integer'}}),'Paginated invitations; no automatic email delivery')),
 'post':operation('inviteServiceMember','Invite service member',write_security,parameters=[app_parameter],requestBody=body(obj({'email':invitation_email,'days':{'type':'integer','minimum':1,'maximum':30}})),responses={'201':jsonresponse(obj({'ok':{'const':True}}),{'ok':True}),**responses}),
 'delete':operation('removeServiceInvitation','Withdraw invitation',write_security,parameters=[app_parameter],requestBody=body(obj({'email':invitation_email})),responses=data_response(obj({'ok':{'const':True}}),'Stops pending enrollment; does not revoke an active membership'))}
preview_row=obj({'userId':{'type':'string','format':'uuid'},'email':invitation_email,'accountType':{'enum':['internal','service']},'enrollment':{'enum':['pending','active']},'pendingUntil':{'type':['string','null'],'format':'date-time'},'lastActivityAt':{'type':['string','null'],'format':'date-time'},'lastReportedActivityAt':{'type':['string','null'],'format':'date-time'},'reason':{'enum':['unfinished_registration','inactive_membership']}})
paths['/api/admin/applications/{applicationId}/lifecycle-preview']={'get':operation('previewMemberLifecycle','Review inactive service memberships without deleting data',read_security,parameters=[app_parameter,{'name':'cursor','in':'query','schema':{'type':'string','format':'uuid'}},{'name':'limit','in':'query','schema':{'type':'integer','minimum':1,'maximum':100,'default':50}}],responses=data_response(obj({'mode':{'const':'preview'},'policy':policy_output,'data':{'type':'array','items':preview_row},'meta':obj({'hasMore':{'type':'boolean'},'nextCursor':{'type':['string','null'],'format':'uuid'}}),'warning':{'type':'string'}}),'Keyset preview only; no notification, suspension or deletion'))}
enrollment_output=obj({'application':obj({'id':{'type':'string','format':'uuid'},'name':{'type':'string'}}),'requirements':obj({'phone':{'type':'boolean'},'line':{'type':'boolean'},'minimumMfa':{'enum':['standard','strong']}}),'missing':{'type':'array','items':{'enum':['phone','line','strong_mfa']}},'enrolled':{'type':'boolean'},'blocked':{'type':'boolean'},'ready':{'type':'boolean'},'registration':{'enum':['closed','invite','open']},'policyVersion':{'type':'integer'},'pendingDays':{'type':'integer'},'inactiveDays':{'type':['integer','null']},'noticeDays':{'type':'integer'},'lifecycleMode':{'const':'preview'},'totpEnabled':{'type':'boolean'},'returnTo':{'type':'string'}})
return_to=string('Validated local authorization request, including original state and PKCE',maxLength=3000)
paths['/api/sso/enrollment']={
 'get':operation('readServiceEnrollment','Read required service enrollment steps',read_security,parameters=[{'name':'returnTo','in':'query','required':True,'schema':return_to}],responses=data_response(enrollment_output,'Own enrollment only; no credentials issued')),
 'post':operation('beginServiceEnrollment','Request provisional service membership',write_security,requestBody=body(obj({'returnTo':return_to})),responses=data_response(enrollment_output,'No role until MFA, service requirements and consent succeed'))}
paths['/api/sso/activity']={'post':{'operationId':'reportServiceActivity','summary':'Report a real user action from the service backend','description':'Requires a dedicated member:activity API-key scope. Subject must be an active member of the key application. Send only actual user interactions, never polling/introspection/cron. Server time is used; eventId is deduplicated for 30 days. At most one update per user/service per 5 minutes; other new events are acknowledged without being stored. Does not revive a revoked membership. No browser CORS or cookie authentication.','tags':['Identity'],'security':[{'ApiKey':[]}],'requestBody':body(obj({'sub':{'type':'string','format':'uuid'},'eventId':{'type':'string','format':'uuid'}})),'responses':data_response(obj({'ok':{'const':True},'duplicate':{'type':'boolean'},'recorded':{'const':False},'retryAfter':{'const':300}},['ok']),'Accepted, duplicate or coalesced activity; see optional flags')}}
for method in paths['/api/admin/applications/{applicationId}/access-policy'].values(): method['description']+=' Central admin only; service roles never authorize administration.'
paths['/api/sso/authorize']['get']['responses']['303']['description']='Redirect to login, service enrollment or consent as required; code only after explicit approval.'
paths['/api/sso/consent']['post']['description']+=' Must include every required scope from the current service policy; required factor enrollment is checked again server-side.'
spec={'openapi':'3.1.0','info':{'title':'CUSA SSO API','version':'1.4.0','description':'Custom first-party SSO: Authorization Code + PKCE S256, opaque tokens, application-scoped roles. Not a full OAuth/OIDC provider; no discovery, ID token, refresh token or dynamic registration. Examples are placeholders; never paste production secrets into browser documentation.'},'servers':[{'url':'/','description':'Same origin as this documentation; production uses HTTPS'}],'tags':[{'name':n} for n in ['Authorization','Tokens','Identity','Consent']],'paths':paths,'components':{'securitySchemes':{'ApiKey':{'type':'apiKey','in':'header','name':'X-API-Key','description':'Application-bound backend secret. Scope identity:read, token:introspect, token:revoke or member:activity as required.'},'CookieSession':{'type':'apiKey','in':'cookie','name':'__Host-cusa_session','description':'HttpOnly Secure cookie in production; cusa_session on localhost development'},'CsrfToken':{'type':'apiKey','in':'header','name':'X-CSRF-Token'},'BearerToken':{'type':'http','scheme':'bearer','bearerFormat':'opaque'}},'schemas':schemas}}
root=Path(__file__).resolve().parents[1]
(root/'web/public/openapi.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2)+'\n')
