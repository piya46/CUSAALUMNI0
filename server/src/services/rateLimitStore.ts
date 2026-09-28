import { createClient } from 'redis';
import { config } from '../config.js';
import { hitRateLimit } from '../models/authModel.js';

let client: ReturnType<typeof createClient> | undefined;
let connecting: Promise<unknown> | undefined;
async function redisClient() {
  if (!client) {
    client = createClient({ url: config.redisUrl, socket: { connectTimeout: 3000, reconnectStrategy: false } });
    // Provider errors must not dump URLs containing credentials into application logs.
    client.on('error', () => {});
  }
  if (!client.isOpen) {
    connecting ??= client.connect().finally(() => { connecting = undefined; });
    await connecting;
  }
  return client;
}
export async function checkRateLimitStore() { if(config.redisUrl)await (await redisClient()).ping(); }
export async function sharedRateLimit(key: string, limit: number, seconds: number) {
  if (!config.redisUrl) return hitRateLimit(key,limit,seconds);
  const redis=await redisClient();
  const count = await redis.eval(`local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]); end; return n`, { keys: [`cusa:rate:${key}`], arguments: [String(seconds)] });
  return Number(count) <= limit;
}
export async function closeRateLimitStore() { if (client?.isOpen) await client.quit(); }
