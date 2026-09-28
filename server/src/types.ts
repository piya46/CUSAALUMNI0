import type { Request } from 'express';
export interface Identity {
  firstName?: string; lastName?: string;
  sessionId: string; userId: string; email: string; name: string; avatar: string | null;
  role: 'admin' | 'user'; kind: 'pending' | 'full'; csrfToken: string;
  totpEnabled: boolean; mfaMethod: string | null; authenticatedAt: Date;
}
declare global { namespace Express { interface Request { identity?: Identity; } } }
export type AuthenticatedRequest = Request & { identity: Identity };
