import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { createInstallRouter } from '../src/routes/installRoutes.js';
import { InstallationError, type InstallationService } from '../src/services/installation.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';

const token = randomBytes(32).toString('base64url');
const origin = 'https://sso.example.test';
const details = { database: 'test_database', host: 'localhost', adminEmail: 'admin@example.test', databaseVersion: '10.11.18-MariaDB' };
function fixture(enabled = true, overrides: Partial<InstallationService> = {}) {
  let reads = 0; let writes = 0;
  const app = express(); app.use(express.json());
  app.use('/api/install', createInstallRouter({ installEnabled: enabled, installToken: token, appOrigin: origin }, {
    check: async () => { reads++; return details; },
    run: async () => { writes++; return { ...details, migrations: [], restartRequired: true }; }, ...overrides,
  }));
  return { app, counts: () => ({ reads, writes }) };
}
const authorized = (app: express.Express, endpoint = 'check') => request(app).post(`/api/install/${endpoint}`)
  .set('Origin', origin).set('Authorization', `Bearer ${token}`);

test('installer is off by default without accessing services even with a correct token', async () => {
  const { app, counts } = fixture(false);
  assert.equal((await authorized(app).send({})).status, 404);
  assert.equal((await authorized(app, 'run').send({ confirm: true })).status, 404);
  assert.deepEqual(counts(), { reads: 0, writes: 0 });
});

test('installer rejects foreign/missing origins, form bodies and secrets supplied in URLs', async () => {
  const { app, counts } = fixture();
  for (const foreign of ['https://evil.example', 'null', `${origin}.evil.example`]) {
    assert.equal((await authorized(app).set('Origin', foreign).send({})).status, 403);
  }
  assert.equal((await request(app).post('/api/install/check').set('Authorization', `Bearer ${token}`).send({})).status, 403);
  assert.equal((await authorized(app).type('form').send({})).status, 403);
  assert.equal((await request(app).post('/api/install/check').set('Origin', origin).query({ token }).send({})).status, 401);
  assert.equal((await authorized(app).set('Authorization', `Bearer ${'x'.repeat(43)}`).send({})).status, 401);
  assert.deepEqual(counts(), { reads: 0, writes: 0 });
});

test('authenticated check is read-only; install requires explicit confirmation and rejects unknown fields', async () => {
  const { app, counts } = fixture();
  const checked = await authorized(app).send({});
  assert.equal(checked.status, 200);
  assert.equal(checked.headers['cache-control'], 'no-store');
  assert.deepEqual(checked.body, details);
  for (const body of [{}, { confirm: false }, { confirm: true, adminEmail: 'attacker@example.test' }]) {
    assert.equal((await authorized(app, 'run').send(body)).status, 400);
  }
  assert.deepEqual(counts(), { reads: 1, writes: 0 });
  assert.equal((await authorized(app, 'run').send({ confirm: true })).status, 201);
  assert.deepEqual(counts(), { reads: 1, writes: 1 });
});

test('installer throttles guesses without a database and does not disclose backend error details', async () => {
  const { app, counts } = fixture();
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await authorized(app).set('Authorization', 'Bearer invalid').send({})).status, 401);
  }
  const limited = await authorized(app).send({});
  assert.equal(limited.status, 429); assert.ok(limited.headers['retry-after']);
  assert.deepEqual(counts(), { reads: 0, writes: 0 });
  const failing = fixture(true, { run: async () => { throw new Error('mysql://secret:password@example'); } });
  const failed = await authorized(failing.app, 'run').send({ confirm: true });
  assert.equal(failed.status, 503); assert.ok(!failed.text.includes('password'));
});

test('installed database cannot be reopened by replaying a valid installer request', async () => {
  let installed = false;
  const { app } = fixture(true, { run: async () => {
    if (installed) throw new InstallationError(409, 'INSTALL_LOCKED', 'Already installed');
    installed = true; return { ...details, migrations: [], restartRequired: true };
  } });
  assert.equal((await authorized(app, 'run').send({ confirm: true })).status, 201);
  const second = await authorized(app, 'run').send({ confirm: true });
  assert.equal(second.status, 409); assert.equal(second.body.code, 'INSTALL_LOCKED');
});

test('application pauses normal APIs in setup mode and closes install page/API when disabled', async () => {
  const previous = config.installEnabled;
  try {
    config.installEnabled = true;
    const setup = createApp();
    for (const path of ['/api/auth/me', '/api/auth/google/start', '/api/admin/users', '/api/sso/authorize', '/api/ready']) {
      assert.equal((await request(setup).get(path)).status, 503);
    }
    const page = await request(setup).get('/install/');
    // Header/guard checks do not require a pre-built frontend in a clean checkout.
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
    config.installEnabled = false;
    const closed = createApp();
    assert.equal((await request(closed).get('/install')).status, 404);
    assert.equal((await request(closed).get('/install/')).status, 404);
    assert.equal((await authorized(closed, 'run').send({ confirm: true })).status, 404);
  } finally { config.installEnabled = previous; }
});
