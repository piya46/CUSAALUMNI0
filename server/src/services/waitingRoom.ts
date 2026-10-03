import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { hashToken } from './crypto.js';
import { queueRedis } from './queueRedis.js';
import type { QueueApplication } from '../models/waitingRoomModel.js';

// All keys share an application hash tag. Atomic bounded work: at most 100
// expired tickets, 100 expired accounts, and 100 admissions per request.
export const waitingRoomScript = `
local tm=redis.call('TIME'); local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
local op=ARGV[1]; local ticket=ARGV[2]; local rate=tonumber(ARGV[3]); local capacity=tonumber(ARGV[4])
local ipLimit=tonumber(ARGV[5]); local flow=ARGV[6]; local account=ARGV[7]
local function save(id,v) redis.call('HSET',KEYS[3],id,cjson.encode(v)); redis.call('ZADD',KEYS[2],v.expires,id) end
for _,id in ipairs(redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',now,'LIMIT',0,100)) do
  redis.call('ZREM',KEYS[1],id); redis.call('HDEL',KEYS[3],id); redis.call('ZREM',KEYS[2],id)
end
for _,id in ipairs(redis.call('ZRANGEBYSCORE',KEYS[7],'-inf',now,'LIMIT',0,100)) do
  redis.call('HDEL',KEYS[6],id); redis.call('ZREM',KEYS[7],id)
end
local raw=redis.call('HGET',KEYS[3],ticket); local entry=nil
if raw then entry=cjson.decode(raw) end
if entry and entry.expires<=now then
  redis.call('ZREM',KEYS[1],ticket); redis.call('HDEL',KEYS[3],ticket); redis.call('ZREM',KEYS[2],ticket); entry=nil
end
if op=='join' and entry and entry.state=='completed' and entry.flow~=flow then
  redis.call('HDEL',KEYS[3],ticket); redis.call('ZREM',KEYS[2],ticket); entry=nil
end
if op=='join' and not entry then
  redis.call('ZREMRANGEBYSCORE',KEYS[5],'-inf',now)
  if redis.call('HLEN',KEYS[3])>=capacity then return cjson.encode({status='full'}) end
  if redis.call('ZCARD',KEYS[5])>=ipLimit and not redis.call('ZSCORE',KEYS[5],ticket) then return cjson.encode({status='ip_limit'}) end
  local seq=redis.call('HINCRBY',KEYS[4],'seq',1)
  entry={state='waiting',createdAt=now,expires=now+3600000,flow=flow}
  save(ticket,entry); redis.call('ZADD',KEYS[1],seq,ticket)
  redis.call('ZADD',KEYS[5],now+3600000,ticket); redis.call('PEXPIRE',KEYS[5],3600000)
end
if not entry then return cjson.encode({status='missing'}) end
-- One Redis wall-clock second is a bounded dispatch window. No unused capacity
-- accumulates across idle windows, restarts or polling gaps.
local window=math.floor(now/1000); local old=tonumber(redis.call('HGET',KEYS[4],'window') or '-1')
if old~=window then redis.call('HSET',KEYS[4],'window',window,'sent',0) end
local sent=tonumber(redis.call('HGET',KEYS[4],'sent') or '0')
local budget=math.max(0,rate-sent)
for n=1,budget do
  local head=redis.call('ZPOPMIN',KEYS[1],1)
  if #head==0 then break end
  local value=redis.call('HGET',KEYS[3],head[1])
  if value then
    local next=cjson.decode(value)
    if next.state=='waiting' and next.expires>now then
      next.state='admitted'; next.expires=now+900000; save(head[1],next)
      redis.call('HINCRBY',KEYS[4],'sent',1)
    end
  end
end
raw=redis.call('HGET',KEYS[3],ticket)
if not raw then return cjson.encode({status='missing'}) end
entry=cjson.decode(raw)
if op=='consume' then
  if entry.state~='admitted' or entry.expires<=now or account=='' then return cjson.encode({status='missing'}) end
  -- One authorization per account/Service per minute while queue mode is on.
  -- This is admission throttling, not a purchase quota or device identity.
  local untilAt=tonumber(redis.call('ZSCORE',KEYS[7],account) or '0')
  if untilAt>now then return cjson.encode({status='duplicate_account'}) end
  redis.call('HSET',KEYS[6],account,ticket); redis.call('ZADD',KEYS[7],now+60000,account)
  redis.call('PEXPIRE',KEYS[6],7200000); redis.call('PEXPIRE',KEYS[7],7200000)
  entry.state='completed'; entry.flow=flow; save(ticket,entry)
  return cjson.encode({status='consumed'})
end
local rank=redis.call('ZRANK',KEYS[1],ticket)
local position=0; if rank then position=rank+1 end
for _,k in ipairs({KEYS[1],KEYS[2],KEYS[3],KEYS[4],KEYS[6],KEYS[7]}) do redis.call('PEXPIRE',k,7200000) end
return cjson.encode({status=entry.state,position=position,total=redis.call('ZCARD',KEYS[1]),expiresAt=entry.expires,etaSeconds=math.ceil(position/rate),restartFlow=(now-(entry.createdAt or now))>300000})
`;

export type QueueResult = { status: 'waiting'|'admitted'|'completed'|'consumed'|'missing'|'full'|'ip_limit'|'duplicate_account';
  position?: number; total?: number; expiresAt?: number; etaSeconds?: number; reference?: string; restartFlow?: boolean };
export function queueKeys(applicationId: string, ip: string) {
  const namespace = createHash('sha256').update(`${config.appOrigin}\0${config.dbName}`).digest('hex').slice(0,16);
  const prefix = `cusa:queue:${namespace}:{${applicationId}}:`;
  return ['waiting','expiry','tickets','clock',`ip:${hashToken(ip)}`,'accounts','account-expiry'].map(key => prefix+key);
}
export async function visitQueue(app: QueueApplication, browser: string, ip: string, returnTo: string,
  operation: 'join'|'check'|'consume', userId = ''): Promise<QueueResult> {
  const ticket = hashToken(`queue:${app.id}:${browser}`);
  const redis = await queueRedis();
  const raw = await redis.withCommandOptions({ timeout: 3000 }).eval(waitingRoomScript, {
    keys: queueKeys(app.id, ip),
    arguments: [operation,ticket,String(app.rate),String(app.capacity),String(app.ipLimit),hashToken(returnTo),userId?hashToken(`queue-account:${app.id}:${userId}`):''],
  });
  const result: QueueResult = JSON.parse(String(raw));
  return { ...result, reference: `TKT-${ticket.slice(0,12).toUpperCase()}` };
}
