import type { Redis } from 'ioredis';
import { PARTITION_ROUTING, partitionFor, validatePartitions } from './partition.js';
import type { Message, TrimStrategy, StreamInfo } from './types.js';

type Script = (source: string, keyCount: number, ...args: Array<string | number | Buffer>) => Promise<unknown>;
/** Uses the owning adapter's script loader and Redis authority; no independent retry layer. */
export class RedisPartitions {
  constructor(private redis: Redis, private key: (kind: string, name: string) => string, private execute: Script) {}
  private policy(stream: string) { return this.key('partition-policy', stream); }
  private indices(stream: string) { return this.key('partition-indices', stream); }
  private index(stream: string, partition: number) { return this.indexPrefix(stream) + partition; }
  private indexPrefix(stream: string) { return this.key('partition-history', JSON.stringify([stream])) + ':'; }
  private groups(stream: string) { return this.key('partition-groups', stream); }
  private decode(raw: string | null): number | undefined {
    if (raw === null || raw === 'legacy') return undefined;
    const prefix = `${PARTITION_ROUTING}:`;
    if (!raw.startsWith(prefix)) throw new Error('Unsupported stream partition routing version');
    const count = Number(raw.slice(prefix.length));
    validatePartitions(count);
    if (String(count) !== raw.slice(prefix.length)) throw new Error('Invalid stream partition policy');
    return count;
  }
  async configure(stream: string, count?: number): Promise<number | undefined> {
    if (count === undefined) return this.decode(await this.redis.get(this.policy(stream)));
    validatePartitions(count);
    const proposed = `${PARTITION_ROUTING}:${count}`;
    const raw = await this.execute(`
local current=redis.call('GET',KEYS[1])
if current then
  if current~=ARGV[1] then return redis.error_reply('Stream partition policy is immutable; migration required') end
  return current
end
if redis.call('EXISTS',KEYS[2])~=0 or redis.call('EXISTS',KEYS[3])~=0 then
  return redis.error_reply('Legacy stream partition migration required before configuration')
end
redis.call('SET',KEYS[1],ARGV[1]);return ARGV[1]
`, 3, this.policy(stream), this.key('stream', stream), this.groups(stream), proposed);
    return this.decode(String(raw));
  }
  async publish(stream: string, message: Message): Promise<string> {
    const count = await this.configure(stream);
    if (count === undefined && message.partition !== undefined) throw new Error('Explicit partition requires configured stream partitioning');
    const partition = count === undefined ? undefined : partitionFor(count, message.id, message.key, message.partition);
    const expected = count === undefined ? 'legacy' : `${PARTITION_ROUTING}:${count}`;
    return String(await this.execute(`
local current=redis.call('GET',KEYS[1])
if current and current~=ARGV[1] then return redis.error_reply('Stream partition policy changed before publication; retry configuration') end
if not current then redis.call('SET',KEYS[1],ARGV[1]) end
local id=redis.call('XADD',KEYS[2],'*','data',ARGV[2],'headers',ARGV[3],'metadata',ARGV[4])
if ARGV[5]~='' then
  redis.call('XADD',KEYS[4],id,'id',id)
  redis.call('ZADD',KEYS[3],tonumber(ARGV[5]),ARGV[5])
end
return id
`, 4, this.policy(stream), this.key('stream', stream), this.indices(stream), this.index(stream, partition ?? 0),
      expected, JSON.stringify(message.data), JSON.stringify(message.headers ?? {}),
      JSON.stringify({ partition, key: message.key, timestamp: message.timestamp }), partition ?? ''));
  }
  async ensureGroup(stream: string, group: string, fromBeginning: boolean): Promise<number | undefined> {
    if (!group) throw new Error('Consumer group requires identity');
    const raw = await this.execute(`
local policy=redis.call('GET',KEYS[1]) or 'legacy'
if policy~='legacy' then
  local count=tonumber(string.sub(policy,string.len(ARGV[5])+1))
  if string.sub(policy,1,string.len(ARGV[5]))~=ARGV[5] or not count or count<1 or count>2147483647 or count~=math.floor(count) or policy~=ARGV[5]..string.format('%.0f',count) then
    return redis.error_reply('Unsupported stream partition policy')
  end
end
if policy=='legacy' then
  local result=redis.pcall('XGROUP','CREATE',KEYS[2],ARGV[1],ARGV[2]=='1' and '0' or '$','MKSTREAM')
  if type(result)=='table' and result.err and not string.find(result.err,'BUSYGROUP',1,true) then return result end
  redis.call('SET',KEYS[1],'legacy')
else
  if not redis.call('HGET',KEYS[3],ARGV[1]) then
    local cutoff='0-0'
    if ARGV[2]~='1' then
      local last=redis.call('XREVRANGE',KEYS[2],'+','-','COUNT',1)
      if #last>0 then cutoff=last[1][1] end
    end
    redis.call('HSET',KEYS[3],ARGV[1],cjson.encode({cutoff=cutoff,cursors=ARGV[3],barriers=ARGV[4]}))
  end
end
return policy
`, 3, this.policy(stream), this.key('stream', stream), this.groups(stream), group, fromBeginning ? '1' : '0', this.cursors(stream, group), this.barriers(stream, group), `${PARTITION_ROUTING}:`);
    return this.decode(String(raw));
  }
  private cursors(stream: string, group: string) { return this.key('partition-cursors', JSON.stringify([stream, group])); }
  private barriers(stream: string, group: string) { return this.key('partition-barriers', JSON.stringify([stream, group])); }
  async claim(stream: string, group: string, room: number, duration: number, attempt: string): Promise<Array<[string, string[], string, string]>> {
    return await this.execute(`
local storedGroup=redis.call('HGET',KEYS[3],ARGV[1])
if not storedGroup then return redis.error_reply('Consumer group does not exist') end
local cutoff=cjson.decode(storedGroup).cutoff
local time=redis.call('TIME'); local now=tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
local scan=redis.call('HGET',KEYS[4],'@scan') or '-1'
local partitions=redis.call('ZRANGEBYSCORE',KEYS[2],'('..scan,'+inf','LIMIT',0,64)
if #partitions==0 then partitions=redis.call('ZRANGEBYSCORE',KEYS[2],0,'+inf','LIMIT',0,64) end
local results={}
for _,partition in ipairs(partitions) do
  redis.call('HSET',KEYS[4],'@scan',partition)
  local raw=redis.call('HGET',KEYS[5],partition)
  local barrier=raw and cjson.decode(raw) or nil
  if not barrier or barrier.expires<=now then
    local rows={}
    if barrier then
      rows=redis.call('XRANGE',KEYS[1],barrier.id,barrier.id,'COUNT',1)
      if #rows==0 then redis.call('HDEL',KEYS[5],partition) end
    end
    if #rows==0 then
      local cursor=redis.call('HGET',KEYS[4],partition) or cutoff
      local ids=redis.call('XRANGE',ARGV[5]..partition,'('..cursor,'+','COUNT',1)
      if #ids>0 then
        local id=ids[1][1]
        rows=redis.call('XRANGE',KEYS[1],id,id,'COUNT',1)
        redis.call('HSET',KEYS[4],partition,id)
      end
    end
    if #rows>0 then
      local id=rows[1][1];local token=ARGV[4]..':'..id
      redis.call('HSET',KEYS[5],partition,cjson.encode({id=id,token=token,expires=now+tonumber(ARGV[3])}))
      table.insert(results,{id,rows[1][2],token,partition})
      if #results>=tonumber(ARGV[2]) then break end
    end
  end
end
return results
`, 5, this.key('stream', stream), this.indices(stream), this.groups(stream), this.cursors(stream, group), this.barriers(stream, group),
      group, room, duration, attempt, this.indexPrefix(stream)) as Array<[string, string[], string, string]>;
  }
  async renew(stream: string, group: string, partition: string, id: string, token: string, duration: number): Promise<boolean> {
    return Boolean(await this.execute(`
local raw=redis.call('HGET',KEYS[2],ARGV[1]);if not raw then return 0 end
local barrier=cjson.decode(raw)
local time=redis.call('TIME');local now=tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
if barrier.id~=ARGV[2] or barrier.token~=ARGV[3] or barrier.expires<=now then return 0 end
if #redis.call('XRANGE',KEYS[1],ARGV[2],ARGV[2],'COUNT',1)==0 then return 0 end
barrier.expires=now+tonumber(ARGV[4]);redis.call('HSET',KEYS[2],ARGV[1],cjson.encode(barrier));return 1
`, 2, this.key('stream', stream), this.barriers(stream, group), partition, id, token, duration));
  }
  async settle(stream: string, group: string, partition: string, id: string, token: string, requeue: boolean): Promise<boolean> {
    return Boolean(await this.execute(`
local raw=redis.call('HGET',KEYS[2],ARGV[1]);if not raw then return 0 end
local barrier=cjson.decode(raw)
local time=redis.call('TIME');local now=tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
if barrier.id~=ARGV[2] or barrier.token~=ARGV[3] or barrier.expires<=now then return 0 end
if ARGV[4]=='1' and #redis.call('XRANGE',KEYS[1],ARGV[2],ARGV[2],'COUNT',1)>0 then
  barrier.token='';barrier.expires=0;redis.call('HSET',KEYS[2],ARGV[1],cjson.encode(barrier))
else redis.call('HDEL',KEYS[2],ARGV[1]) end
return 1
`, 2, this.key('stream', stream), this.barriers(stream, group), partition, id, token, requeue ? '1' : '0'));
  }

  async trim(stream: string, strategy: TrimStrategy): Promise<number> {
    return Number(await this.execute(`
local removed=0
if ARGV[1]~='' then removed=removed+redis.call('XTRIM',KEYS[1],'MAXLEN',ARGV[1]) end
if ARGV[2]~='' then
  local time=redis.call('TIME')
  local cutoff=math.floor(tonumber(time[1])*1000+tonumber(time[2])/1000-tonumber(ARGV[2])*1000)
  if cutoff>=0 then removed=removed+redis.call('XTRIM',KEYS[1],'MINID',string.format('%.0f',cutoff+1)..'-0') end
end
local first=redis.call('XRANGE',KEYS[1],'-','+','COUNT',1)
for _,partition in ipairs(redis.call('ZRANGE',KEYS[2],0,-1)) do
  local key=ARGV[3]..partition
  if #first==0 then redis.call('DEL',key)
  else redis.call('XTRIM',key,'MINID',first[1][1]) end
  if redis.call('XLEN',key)==0 then redis.call('DEL',key);redis.call('ZREM',KEYS[2],partition) end
end
return removed
`, 2, this.key('stream', stream), this.indices(stream), strategy.maxLength ?? '', strategy.maxAgeSeconds ?? '', this.indexPrefix(stream)));
  }
  async info(stream: string, count: number): Promise<StreamInfo> {
    const result = await this.execute(`
local lag=0
local groups=redis.call('HGETALL',KEYS[3])
local partitions=redis.call('ZRANGE',KEYS[2],0,-1)
for i=1,#groups,2 do
  local metadata=cjson.decode(groups[i+1]);local cutoff=metadata.cutoff
  local cursorKey=metadata.cursors;local barrierKey=metadata.barriers
  for _,partition in ipairs(partitions) do
    local cursor=redis.call('HGET',cursorKey,partition) or cutoff
    lag=lag+#redis.call('XRANGE',ARGV[1]..partition,'('..cursor,'+')
    local raw=redis.call('HGET',barrierKey,partition)
    if raw then
      local barrier=cjson.decode(raw)
      if #redis.call('XRANGE',KEYS[1],barrier.id,barrier.id,'COUNT',1)>0 then lag=lag+1 end
    end
  end
end
return {redis.call('XLEN',KEYS[1]),#groups/2,lag}
`, 3, this.key('stream', stream), this.indices(stream), this.groups(stream), this.indexPrefix(stream)) as number[];
    return { name: stream, partitions: count, length: Number(result[0]), groups: Number(result[1]), lag: Number(result[2]) };
  }
}
