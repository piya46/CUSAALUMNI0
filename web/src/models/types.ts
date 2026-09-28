export type Page = 'overview' | 'users' | 'allowlist' | 'applications' | 'serviceAccess' | 'keys' | 'security' | 'sessions' | 'audit' | 'integration';
export interface User { firstName?: string; lastName?: string; id: string; email: string; name: string; avatar?: string | null; role: 'admin' | 'user'; totpEnabled: boolean; lastLoginAt?: string | null; createdAt?: string }
export interface Identity { user: User; csrfToken: string; requiresMfa: boolean; mfaMethod: 'totp' | 'email' | 'recovery' | null; status?: 'mfa_required' | 'authenticated'; recoveryCodesRemaining?: number }
export interface AllowedEmail { id: string; email: string; role: 'admin' | 'user'; createdAt: string }
export interface Application { id: string; name: string; description: string; redirectUri: string; createdAt: string; revokedAt: string | null }
export interface ApiKey { id: string; applicationId: string; name: string; prefix: string; scopes: string[]; createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null }
export interface Session { id: string; createdAt: string; expiresAt: string; current: boolean; mfaMethod: string }
export interface AuditEvent { status?: 'success' | 'failure'; sessionId?: string | null; userAgent?: string | null; id: string; actorEmail: string; event: string; target: string | null; ip: string; metadata: Record<string, unknown> | null; createdAt: string }
export interface Stats { users: number; allowedEmails: number; applications: number; activeApiKeys: number; mfaEnabled: number; activeSessions: number }
export interface ServiceRole { id: string; applicationId: string; code: string; name: string; description: string }
export interface ServiceMember { applicationId: string; userId: string; name: string; email: string; department: string; roleIds: string[] }
export interface Dataset { serviceRoles: ServiceRole[]; serviceMembers: ServiceMember[]; users: User[]; emails: AllowedEmail[]; applications: Application[]; apiKeys: ApiKey[]; sessions: Session[]; events: AuditEvent[]; stats: Stats }
export const emptyData: Dataset = { serviceRoles: [], serviceMembers: [], users: [], emails: [], applications: [], apiKeys: [], sessions: [], events: [], stats: { users: 0, allowedEmails: 0, applications: 0, activeApiKeys: 0, mfaEnabled: 0, activeSessions: 0 } };

export interface PageMeta { total: number; totalPages: number; currentPage: number; limit: number }
