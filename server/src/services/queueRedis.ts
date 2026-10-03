import { createClient } from 'redis';
import { config } from '../config.js';
import { permitsUnencryptedDatabase } from './databaseTransport.js';

let client: ReturnType<typeof createClient> | undefined;
let connecting: Promise<unknown> | undefined;
export async function queueRedis() {
  if (!config.redisUrl) throw new Error('Queue requires Redis');
  const url = new URL(config.redisUrl);
  if (!['redis:','rediss:'].includes(url.protocol) || (config.nodeEnv==='production' && url.protocol!=='rediss:' && !permitsUnencryptedDatabase(url.hostname)))
    throw new Error('Queue requires verified Redis transport');
  if (!client) {
    client = createClient({ url: config.redisUrl, disableOfflineQueue: true, commandsQueueMaxLength: 1000,
      socket: { connectTimeout: 3000, reconnectStrategy: false } });
    client.on('error', () => {});
  }
  if (!client.isOpen) {
    connecting ??= client.connect().finally(() => { connecting = undefined; });
  }
  if (connecting) await connecting;
  if (!client.isReady) throw new Error('Queue Redis is not ready');
  return client;
}
export async function closeQueueRedis() { if (client?.isOpen) client.destroy(); }
