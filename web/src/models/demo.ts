import type { Dataset, Identity } from './types';
const ago = (hours: number) => new Date(Date.now() - hours * 3600000).toISOString();
const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
export const demoIdentity: Identity = { user: { id: 'demo-admin', email: 'admin@example.com', name: 'Workspace Admin', role: 'admin', totpEnabled: true }, csrfToken: '', requiresMfa: false, mfaMethod: 'totp' };
export function makeDemoData(): Dataset {
  const users = [
    { ...demoIdentity.user, lastLoginAt: ago(0.05), createdAt: ago(500) },
    { id: 'user-2', name: 'ณัฐธิดา วัฒนกุล', email: 'nattida@example.com', role: 'admin' as const, totpEnabled: true, lastLoginAt: ago(0.3), createdAt: ago(340) },
    { id: 'user-3', name: 'กิตติพงษ์ สิริชัย', email: 'kittipong@example.com', role: 'user' as const, totpEnabled: true, lastLoginAt: ago(1), createdAt: ago(300) },
    { id: 'user-4', name: 'พิมพ์ชนก ศรีสวัสดิ์', email: 'pimchanok@example.com', role: 'user' as const, totpEnabled: false, lastLoginAt: ago(3), createdAt: ago(210) },
    { id: 'user-5', name: 'ธนภัทร กาญจนพงศ์', email: 'tanapat@example.com', role: 'user' as const, totpEnabled: true, lastLoginAt: ago(6), createdAt: ago(190) },
    { id: 'user-6', name: 'อรปรียา สุขสันต์', email: 'ornpreeya@example.com', role: 'user' as const, totpEnabled: false, lastLoginAt: ago(20), createdAt: ago(120) },
  ];
  const emails = users.map((u, i) => ({ id: `email-${i}`, email: u.email, role: u.role, createdAt: u.createdAt }));
  emails.push({ id: 'email-pending', email: 'new.member@example.com', role: 'user', createdAt: ago(1) });
  const applications = [
    { id: 'app-1', name: 'CUSA Workspace', description: 'พื้นที่ทำงานและจัดการเอกสารของทีม', redirectUri: 'https://workspace.example.com/auth/callback', createdAt: ago(410), revokedAt: null },
    { id: 'app-2', name: 'People & HR', description: 'ระบบบริหารบุคลากรและการลางาน', redirectUri: 'https://people.example.com/auth/callback', createdAt: ago(230), revokedAt: null },
    { id: 'app-3', name: 'Analytics Hub', description: 'รายงานและข้อมูลเชิงลึกขององค์กร', redirectUri: 'https://analytics.example.com/auth/callback', createdAt: ago(100), revokedAt: null },
  ];
  const apiKeys = [
    { id: 'key-1', applicationId: 'app-1', name: 'Workspace production', prefix: 'cusa_a8f2c10d', scopes: ['identity:read', 'token:introspect'], createdAt: ago(400), expiresAt: future(60), lastUsedAt: ago(0.1), revokedAt: null },
    { id: 'key-2', applicationId: 'app-2', name: 'People service', prefix: 'cusa_9b1e04a2', scopes: ['identity:read', 'token:introspect'], createdAt: ago(220), expiresAt: future(29), lastUsedAt: ago(0.4), revokedAt: null },
    { id: 'key-3', applicationId: 'app-3', name: 'Analytics integration', prefix: 'cusa_34c09a1e', scopes: ['identity:read', 'token:introspect'], createdAt: ago(90), expiresAt: future(83), lastUsedAt: ago(2), revokedAt: null },
  ];
  const events = [
    { id: 'event-1', actorEmail: 'admin@example.com', event: 'auth.login', target: 'CUSA SSO', ip: '192.0.2.10', metadata: null, createdAt: ago(0.05) },
    { id: 'event-2', actorEmail: 'nattida@example.com', event: 'auth.mfa_verified', target: 'Authenticator', ip: '192.0.2.12', metadata: null, createdAt: ago(0.3) },
    { id: 'event-3', actorEmail: 'admin@example.com', event: 'allowlist.created', target: 'new.member@example.com', ip: '192.0.2.10', metadata: null, createdAt: ago(1) },
    { id: 'event-4', actorEmail: 'kittipong@example.com', event: 'auth.login', target: 'CUSA SSO', ip: '192.0.2.23', metadata: null, createdAt: ago(1.1) },
    { id: 'event-5', actorEmail: 'admin@example.com', event: 'api_key.created', target: 'Analytics integration', ip: '192.0.2.10', metadata: null, createdAt: ago(2) },
    { id: 'event-6', actorEmail: 'pimchanok@example.com', event: 'auth.otp_verified', target: 'Email OTP', ip: '192.0.2.34', metadata: null, createdAt: ago(3) },
  ];
  const serviceRoles = applications.map(app => ({ id: `role-${app.id}`, applicationId: app.id, code: 'viewer', name: 'ผู้ดูข้อมูล', description: 'อ่านข้อมูลใน Service' }));
  const serviceMembers = applications.map((app, i) => ({ applicationId: app.id, userId: users[i].id, name: users[i].name, email: users[i].email, department: i === 1 ? 'ทรัพยากรบุคคล' : 'เทคโนโลยีสารสนเทศ', roleIds: [`role-${app.id}`] }));
  return { serviceRoles, serviceMembers, users, emails, applications, apiKeys, events, sessions: [
    { id: 'session-current', createdAt: ago(0.05), expiresAt: future(0.3), current: true, mfaMethod: 'totp' },
    { id: 'session-other', createdAt: ago(2), expiresAt: future(0.2), current: false, mfaMethod: 'email' },
  ], stats: { users: users.length, allowedEmails: emails.length, applications: applications.length, activeApiKeys: apiKeys.length, mfaEnabled: 4, activeSessions: 8 } };
}
