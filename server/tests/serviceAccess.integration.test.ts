import { consentedCode } from './consent-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { execute, pool, query } from '../src/db.js';
import * as access from '../src/models/serviceAccessModel.js';
import * as admin from '../src/models/adminModel.js';
import { createSsoModel, pkceChallenge } from '../src/models/ssoModel.js';
import { hashToken, randomToken } from '../src/services/crypto.js';
import { recordAudit } from '../src/models/authModel.js';
import { config } from '../src/config.js';

const enabled = process.env.RUN_DB_TESTS === '1';
after(() => pool.end());
test('service memberships and roles are isolated, audited, revocable, and enforced at every SSO stage', { skip: !enabled }, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(config.dbHost)); assert.match(config.dbName, /_test$/);
  const userId = randomUUID(), actorId = randomUUID(), appA = randomUUID(), appB = randomUUID();
  const email = `${userId}@example.test`, adminEmail = `${actorId}@example.test`;
  const actor = { userId: actorId, email: adminEmail };
  const audit: admin.AuditWriter = async (conn, event, target, metadata) => {
    await recordAudit({ actorId, actorEmail: adminEmail, sessionId: null, status: 'success', userAgent: 'service-access-test', event, target: target ?? null, ip: '127.0.0.1', metadata }, conn);
  };
  const noAudit: admin.AuditWriter = async () => {};
  const sso = createSsoModel();
  const sessionId = randomUUID(), keyA = randomToken(), keyB = randomToken(), verifier = randomToken();
  const redirectUri = 'https://service.example.test/callback';
  async function token(app: string, key: string) {
    const code = await consentedCode(sso,{ applicationId: app, userId, sessionId, redirectUri, challenge: pkceChallenge(verifier) });
    return sso.exchangeAuthorizationCode({ apiKeyHash: hashToken(key), codeHash: hashToken(code), redirectUri, verifier });
  }
  try {
    for (const [id, address, platformRole] of [[actorId, adminEmail, 'admin'], [userId, email, 'user']]) {
      await execute('INSERT INTO allowed_emails (id,email,role) VALUES (?,?,?)', [randomUUID(), address, platformRole]);
      await execute('INSERT INTO users (id,google_sub,email,name) VALUES (?,?,?,?)', [id, `service-test-${id}`, address, 'Google Display']);
    }
    for (const [app, key] of [[appA, keyA], [appB, keyB]]) {
      await execute('INSERT INTO applications (id,name,redirect_uri) VALUES (?,?,?)', [app, app, redirectUri]);
      await execute('INSERT INTO application_access_policies(application_id) VALUES (?)',[app]);
      await execute('INSERT INTO api_keys (id,application_id,name,prefix,key_hash,scopes,expires_at) VALUES (?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))', [randomUUID(), app, 'test', 'test', hashToken(key), JSON.stringify(['identity:read','token:introspect'])]);
    }
    await execute("INSERT INTO sessions (id,token_hash,user_id,kind,csrf_token,mfa_method,authenticated_at,expires_at) VALUES (?,?,?,'full',?,'totp',UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))", [sessionId, hashToken(randomToken()), userId, randomToken()]);
    await assert.rejects(token(appA, keyA), { code: 'access_denied' });
    await execute('INSERT INTO application_memberships (application_id,user_id) VALUES (?,?)', [appA,userId]);
    await assert.rejects(token(appA, keyA), { code: 'access_denied' });
    const viewerA = await access.saveRole(actor, appA, null, { code: 'viewer', name: 'ผู้ดูข้อมูล', description: '' }, audit);
    const approverA = await access.saveRole(actor, appA, null, { code: 'approver', name: 'ผู้อนุมัติ', description: '' }, audit);
    const viewerB = await access.saveRole(actor, appB, null, { code: 'viewer', name: 'อ่านข้อมูลบัญชี', description: '' }, audit);
    await assert.rejects(access.saveRole(actor, appA, null, { code: 'viewer', name: 'duplicate', description: '' }, audit), { code: 'ROLE_EXISTS' });
    await assert.rejects(access.saveRole(actor, appA, viewerB.id, { code: 'viewer', name: 'wrong service', description: '' }, audit), { code: 'NOT_FOUND' });
    await assert.rejects(access.saveMember(actor, appA, userId, { department: 'HR', roleIds: [viewerB.id] }, audit), { code: 'INVALID_SERVICE_ROLE' });
    await assert.rejects(access.saveMember({ userId, email }, appA, userId, { department: '', roleIds: [viewerA.id] }, audit), { code: 'ADMIN_REVOKED' });
    await admin.updateUserProfile(actor, userId, { firstName: 'สมชาย', lastName: 'ใจดี' }, audit);
    await access.saveMember(actor, appA, userId, { department: 'HR', roleIds: [viewerA.id, approverA.id] }, audit);
    await access.saveMember(actor, appB, userId, { department: 'Finance', roleIds: [viewerB.id] }, audit);
    const a = await token(appA, keyA), b = await token(appB, keyB);
    const infoA = await sso.getUserInfo(hashToken(a.accessToken)), infoB = await sso.getUserInfo(hashToken(b.accessToken));
    assert.equal(infoA?.given_name, 'สมชาย'); assert.equal(infoA?.family_name, 'ใจดี'); assert.equal(infoA?.name, 'สมชาย ใจดี');
    assert.equal(infoA?.department, 'HR'); assert.deepEqual(infoA?.roles.sort(), ['approver','viewer']);
    assert.equal(infoB?.department, 'Finance'); assert.deepEqual(infoB?.roles, ['viewer']);
    assert.deepEqual(await sso.introspectToken(hashToken(keyB), hashToken(a.accessToken)), { active: false });
    const activeA = await sso.introspectToken(hashToken(keyA), hashToken(a.accessToken));
    assert.equal(activeA.active, true); if (activeA.active) assert.deepEqual(activeA.roles.sort(), ['approver','viewer']);
    assert.equal((await query<{ role: string }>('SELECT role FROM allowed_emails WHERE email=?', [email]))[0].role, 'user');
    const list = await access.listMembers(appA, { page: 1, limit: 1, search: 'HR' });
    assert.equal(list.meta.total, 1); assert.equal(list.members[0].roleIds.length, 2);
    await assert.rejects(access.revokeRole(actor, appA, viewerA.id, audit), { code: 'ROLE_IN_USE' });
    await assert.rejects(access.saveMember(actor, appA, userId, { department: 'changed', roleIds: [approverA.id] }, async () => { throw new Error('audit unavailable'); }), /audit unavailable/);
    assert.equal((await sso.getUserInfo(hashToken(a.accessToken)))?.department, 'HR');
    const pendingCode = await consentedCode(sso,{ applicationId: appA, userId, sessionId, redirectUri, challenge: pkceChallenge(verifier) });
    await access.saveMember(actor, appA, userId, { department: 'HR', roleIds: [approverA.id] }, audit);
    assert.equal(await sso.getUserInfo(hashToken(a.accessToken)), null);
    assert.equal((await sso.getUserInfo(hashToken(b.accessToken)))?.department, 'Finance');
    await assert.rejects(sso.exchangeAuthorizationCode({ apiKeyHash: hashToken(keyA), codeHash: hashToken(pendingCode), redirectUri, verifier }), { code: 'invalid_grant' });
    await access.revokeRole(actor, appA, viewerA.id, audit);
    await assert.rejects(access.saveMember(actor, appA, userId, { department: '', roleIds: [viewerA.id] }, audit), { code: 'INVALID_SERVICE_ROLE' });
    const fresh = await token(appA, keyA);
    await access.revokeMember(actor, appA, userId, audit);
    assert.equal(await sso.getUserInfo(hashToken(fresh.accessToken)), null);
    await assert.rejects(token(appA, keyA), { code: 'access_denied' });
    assert.deepEqual((await sso.getUserInfo(hashToken(b.accessToken)))?.roles, ['viewer']);
    const [{ count }] = await query<{ count: number }>("SELECT COUNT(*) AS count FROM audit_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.actorId'))=?", [actorId]);
    assert.ok(Number(count) >= 9);
    await admin.removeUser(actor, userId, noAudit);
    assert.equal((await access.listMembers(appB, { page: 1, limit: 10, search: '' })).meta.total, 0);
  } finally {
    await execute("DELETE FROM audit_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.actorId'))=?", [actorId]);
    for (const app of [appA, appB]) await execute('DELETE FROM applications WHERE id=?', [app]);
    for (const id of [actorId,userId]) await execute('DELETE FROM users WHERE id=?', [id]);
    for (const address of [email,adminEmail]) await execute('DELETE FROM allowed_emails WHERE email=?', [address]);
  }
});
