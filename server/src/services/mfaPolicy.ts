// These methods establish administrative assurance after Google sign-in.
// Phone ownership, email, LINE and recovery alone must never elevate an admin.
export function isStrongMfa(method: unknown): boolean {
  return method === 'totp' || method === 'passkey';
}

export function isFreshStrongMfa(method: unknown, authenticatedAt: Date | string | null | undefined, now = Date.now()): boolean {
  const at = authenticatedAt ? new Date(authenticatedAt).getTime() : NaN;
  return isStrongMfa(method) && Number.isFinite(at) && at <= now + 10_000 && now - at <= 300_000;
}

export function hasAdminMfa(session: { kind: string; totpEnabled: boolean; mfaMethod: unknown }): boolean {
  return session.kind === 'full' && session.totpEnabled && isStrongMfa(session.mfaMethod);
}
