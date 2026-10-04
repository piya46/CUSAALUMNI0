export type SsoErrorCode = 'invalid_client' | 'insufficient_scope' | 'invalid_grant' | 'access_denied' | 'invalid_scope';
export class SsoModelError extends Error {
  constructor(public readonly code: SsoErrorCode) { super(code); }
}
