export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
let csrfToken = '';
export function setCsrfToken(token: string) { csrfToken = token; }

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(result.error || 'ไม่สามารถเชื่อมต่อระบบได้ กรุณาลองอีกครั้ง', response.status);
  return result as T;
}
