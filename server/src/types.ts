import type { Request } from 'express';
export interface Identity {
  firstName?: string; lastName?: string; phoneRequired?:boolean;
  sessionId: string; userId: string; email: string; name: string; avatar: string | null;
  role: 'admin' | 'user' | 'service'; kind: 'pending' | 'full'; csrfToken: string;
  totpEnabled: boolean; mfaMethod: string | null; authenticatedAt: Date;
}
declare global { namespace Express { interface Request { identity?: Identity; evidenceProcessing?:boolean; releaseEvidenceCapacity?:()=>void; context?: {requestId:string;clientIp:string;peerIp:string;ipSource:string}; service?:{applicationId:string;apiKeyId:string}; auditRecorded?:boolean; } } }
export type AuthenticatedRequest = Request & { identity: Identity };
