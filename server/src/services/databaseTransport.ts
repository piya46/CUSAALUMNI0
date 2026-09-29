import { BlockList, isIP } from 'node:net';

const internalAddresses = new BlockList();
internalAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
internalAddresses.addSubnet('10.0.0.0', 8, 'ipv4');
internalAddresses.addSubnet('172.16.0.0', 12, 'ipv4');
internalAddresses.addSubnet('192.168.0.0', 16, 'ipv4');
internalAddresses.addAddress('::1', 'ipv6');
internalAddresses.addSubnet('fc00::', 7, 'ipv6');

// Explicit DB_TLS=false is supported for a local database or a provider-managed
// private network. An address in these ranges does not prove network isolation;
// the deployment operator must verify the actual route and access controls.
// Do not infer private routing from a provider name or an arbitrary DNS suffix.
export function permitsUnencryptedDatabase(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  const family = isIP(host);
  if (!family || host.includes('%')) return false;
  return internalAddresses.check(host, family === 4 ? 'ipv4' : 'ipv6');
}
