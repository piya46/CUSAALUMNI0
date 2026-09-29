export class ApiError extends Error {
  constructor(message: string, public status: number, public code?:string, public retryAfter=0) { super(message); }
}
let csrfToken = '';
let reauthenticate:(()=>Promise<void>)|undefined;
export function setReauthenticationHandler(handler?:()=>Promise<void>){reauthenticate=handler;}
export function setCsrfToken(token: string) { csrfToken = token; }

export async function api<T>(path: string, method = 'GET', body?: unknown, retry=true): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({})) as { error?: string;code?:string };
  if(response.status===403 && result.code==='MFA_REAUTH_REQUIRED' && retry && reauthenticate){await reauthenticate();return api<T>(path,method,body,false);}
  if (!response.ok) throw new ApiError(result.error || 'ไม่สามารถเชื่อมต่อระบบได้ กรุณาลองอีกครั้ง', response.status,result.code,Number(response.headers.get('Retry-After')||0));
  return result as T;
}

export async function apiFile(path:string,retry=true):Promise<Blob>{
  const response=await fetch(`/api${path}`,{credentials:'same-origin',cache:'no-store'});
  if(response.ok)return response.blob();
  const error=await response.json().catch(()=>({}));
  if(response.status===403&&error.code==='MFA_REAUTH_REQUIRED'&&retry&&reauthenticate){await reauthenticate();return apiFile(path,false);}
  throw new ApiError(error.error??'เปิดหลักฐานไม่ได้',response.status,error.code);
}
export async function apiUpload<T>(path:string,body:FormData):Promise<T>{
  const response=await fetch(`/api${path}`,{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':csrfToken},body});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new ApiError(data.error??'ส่งหลักฐานไม่สำเร็จ',response.status,data.code,Number(response.headers.get('Retry-After')||0));
  return data as T;
}
