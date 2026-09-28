// Fixed non-production test material, never loaded by application startup.
process.env.NODE_ENV='test';
process.env.SESSION_SECRET ??= 'test-only-pepper-with-at-least-thirty-two-characters';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32,7).toString('base64');
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_TLS ??= 'false';
if (process.env.RUN_DB_TESTS === '1' && !['127.0.0.1','localhost'].includes(process.env.DB_HOST)) throw new Error('Database tests are restricted to local MariaDB');
if (process.env.RUN_DB_TESTS === '1' && !/_test$/.test(process.env.DB_NAME??'')) throw new Error('Database tests require an explicit database name ending in _test');
