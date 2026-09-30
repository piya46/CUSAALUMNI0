import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

test('patched uuid preserves the CommonJS v4 API used by optional Google Storage gaxios',()=>{
  const require=createRequire(import.meta.url);
  const storageRequire=createRequire(require.resolve('@google-cloud/storage'));
  const gaxiosRequire=createRequire(storageRequire.resolve('gaxios'));
  const uuid=gaxiosRequire('uuid');
  assert.match(uuid.v4(),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // GHSA-w5hq-g745-h8pq: caller-provided undersized buffers must throw.
  assert.throws(()=>uuid.v5('test',uuid.v5.DNS,new Uint8Array(8),4),RangeError);
  assert.equal(typeof storageRequire('gaxios').request,'function');
});
