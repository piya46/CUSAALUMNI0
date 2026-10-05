import { api } from './api';

export interface LoginContext {
  application: { name: string; origin: string };
  returnTo: string; registration?:'closed'|'invite'|'open';
}

export async function getLoginContext(returnTo: string): Promise<LoginContext> {
  // Only our authorization endpoint can resume a login. The server validates every parameter.
  if (!returnTo.startsWith('/api/sso/authorize?') || returnTo.length > 3000 || /[\r\n#]/.test(returnTo)) {
    throw new Error('คำขอเข้าสู่ระบบไม่ถูกต้อง กรุณาเริ่มใหม่จากแอปที่ต้องการใช้งาน');
  }
  return api<LoginContext>(`/sso/login-context?${returnTo.slice('/api/sso/authorize?'.length)}`);
}
