import assert from 'node:assert/strict';
import test from 'node:test';
import { membershipSchema, profileSchema, serviceRoleSchema } from '../src/controllers/serviceAccessController.js';

test('service roles, memberships and profiles cannot smuggle platform privileges or foreign request fields', () => {
  assert.equal(profileSchema.safeParse({ firstName: 'A', lastName: 'B', role: 'admin' }).success, false);
  assert.equal(membershipSchema.safeParse({ department: 'Finance', roleIds: [], role: 'admin' }).success, false);
  const id = 'b7ab297a-8903-4550-b3cc-c11daed7a824';
  assert.equal(membershipSchema.safeParse({ roleIds: [id, id] }).success, false);
  assert.equal(membershipSchema.safeParse({ roleIds: [id], applicationId: id }).success, false);
  assert.equal(serviceRoleSchema.safeParse({ code: 'Approver', name: 'A' }).success, false);
  assert.equal(profileSchema.safeParse({ firstName: 'A\nB', lastName: '' }).success, false);
  assert.deepEqual(serviceRoleSchema.parse({ code: 'approver', name: ' ผู้อนุมัติ ' }), { code: 'approver', name: 'ผู้อนุมัติ', description: '' });
});
