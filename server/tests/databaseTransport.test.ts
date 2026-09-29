import test from 'node:test';
import assert from 'node:assert/strict';
import { permitsUnencryptedDatabase } from '../src/services/databaseTransport.js';

test('allows local database addresses and private IPv4/IPv6 network boundaries', () => {
  for (const host of ['localhost','LOCALHOST','127.0.0.1','127.255.255.254','::1','0:0:0:0:0:0:0:1',
    '10.0.0.0','10.255.255.255','172.16.0.0','172.31.255.255','192.168.0.0','192.168.255.255',
    'fc00::1','fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff','::ffff:10.1.2.3']) {
    assert.equal(permitsUnencryptedDatabase(host), true, host);
  }
});

test('rejects public addresses, adjacent ranges, unspecified and multicast addresses', () => {
  for (const host of ['203.170.190.137','9.255.255.255','11.0.0.0','172.15.255.255','172.32.0.0',
    '192.167.255.255','192.169.0.0','0.0.0.0','169.254.1.1','224.0.0.1','::','fe80::1','ff02::1',
    '2001:4860:4860::8888','::ffff:203.170.190.137']) {
    assert.equal(permitsUnencryptedDatabase(host), false, host);
  }
});

test('does not treat hostnames, alternate numeric notation or URLs as private IPs', () => {
  for (const host of ['','db.internal','localhost.example.com','10.0.0.1.example.com','127.1',
    '2130706433','0x7f000001','http://127.0.0.1','127.0.0.1:3306','10.999.1.1',' localhost',
    'localhost\n','[::1]','fe80::1%eth0']) {
    assert.equal(permitsUnencryptedDatabase(host), false, JSON.stringify(host));
  }
});
