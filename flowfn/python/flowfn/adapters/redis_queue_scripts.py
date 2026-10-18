"""Atomic common queue operations preserving the original JSON byte structure.

Redis cjson cannot round-trip empty arrays reliably. Decode only for inspection;
replace selected top-level scalar spans without re-encoding user payloads.
"""
_PATCH = r'''
local function skip_string(raw, i)
  i = i + 1
  while i <= #raw do
    local c = string.sub(raw,i,i)
    if c == '\\' then i=i+2
    elseif c == '"' then return i+1
    else i=i+1 end
  end
  error('Invalid JSON string')
end
local function patch(raw, field, literal)
  local i=2
  while i <= #raw do
    while string.match(string.sub(raw,i,i),'[%s,]') do i=i+1 end
    if string.sub(raw,i,i)=='}' then break end
    local key_start=i
    i=skip_string(raw,i)
    local key=cjson.decode(string.sub(raw,key_start,i-1))
    while string.match(string.sub(raw,i,i),'[%s:]') do i=i+1 end
    local value_start=i
    local depth=0
    while i <= #raw do
      local c=string.sub(raw,i,i)
      if c=='"' then i=skip_string(raw,i)
      elseif c=='{' or c=='[' then depth=depth+1;i=i+1
      elseif c=='}' or c==']' then
        if depth==0 then break end
        depth=depth-1;i=i+1
      elseif c==',' and depth==0 then break
      else i=i+1 end
    end
    if key==field then
      return string.sub(raw,1,value_start-1)..literal..string.sub(raw,i)
    end
  end
  error('Missing queue JSON field: '..field)
end
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local base=KEYS[1]
'''

ENQUEUE = _PATCH + r'''
local raw=ARGV[1]
local job=cjson.decode(raw)
local existing=redis.call('HGET',base..':jobs',job.id)
if existing then return {existing,0} end
if job.opts.prevent_duplicates and ARGV[4]=='1' then
  local ids=redis.call('SMEMBERS',base..':dedup:'..ARGV[3])
  local first=nil
  local score=nil
  for _,id in ipairs(ids) do
    local position=tonumber(redis.call('ZSCORE',base..':sequence',id))
    if position and (not score or position<score) then first=id;score=position end
  end
  if first then return {redis.call('HGET',base..':jobs',first),0} end
end
local due=job.available_at
if due==cjson.null then due=job.timestamp+job.delay end
if job.delay==0 and due<=job.timestamp then
  due=now
  raw=patch(raw,'available_at',tostring(now))
end
local position=redis.call('INCR',base..':counter')
local member=string.format('%020d',position)..':'..job.id
redis.call('HSET',base..':jobs',job.id,raw)
redis.call('ZADD',base..':sequence',position,job.id)
redis.call('ZADD',base..':status:'..job.state,position,job.id)
if job.state=='waiting' or job.state=='delayed' then
  if due<=now then redis.call('ZADD',base..':ready',job.opts.priority,member)
  else redis.call('ZADD',base..':due',due,member) end
end
if job.state=='active' and job.lease_expires_at~=cjson.null then
  redis.call('ZADD',base..':leases',job.lease_expires_at,job.id)
end
if job.state~='completed' and job.state~='failed' and ARGV[4]=='1' then
  redis.call('SADD',base..':dedup:'..ARGV[3],job.id)
end
redis.call('INCR',base..':version')
redis.call('SADD',KEYS[2],ARGV[2])
return {raw,1}
'''

DEQUEUE = _PATCH + r'''
if redis.call('SCARD',base..':children')>0 or redis.call('ZCOUNT',base..':leases','-inf',now)>0 or redis.call('ZCOUNT',base..':due','-inf',now)>0 then return {'fallback'} end
local members=redis.call('ZRANGE',base..':ready',0,0)
if #members==0 then return {'empty'} end
local member=members[1]
local id=string.sub(member,22)
local raw=redis.call('HGET',base..':jobs',id)
if not raw then return {'fallback'} end
local job=cjson.decode(raw)
if job.opts.backoff~=cjson.null and job.opts.backoff.type=='custom' then return {'fallback'} end
local expires=now+tonumber(ARGV[2])
raw=patch(raw,'state','"active"')
raw=patch(raw,'lease_token',cjson.encode(ARGV[1]))
raw=patch(raw,'lease_expires_at',tostring(expires))
local position=redis.call('ZSCORE',base..':sequence',id)
redis.call('HSET',base..':jobs',id,raw)
redis.call('ZREM',base..':ready',member)
redis.call('ZREM',base..':status:'..job.state,id)
redis.call('ZADD',base..':status:active',position,id)
redis.call('ZADD',base..':leases',expires,id)
redis.call('INCR',base..':version')
return {'claimed',raw}
'''

RENEW = _PATCH + r'''
local raw=redis.call('HGET',base..':jobs',ARGV[1])
if not raw then return 0 end
local job=cjson.decode(raw)
if job.state~='active' or job.lease_token~=ARGV[2] or job.lease_expires_at==cjson.null or job.lease_expires_at<=now then return 0 end
local expires=now+tonumber(ARGV[3])
raw=patch(raw,'lease_expires_at',tostring(expires))
redis.call('HSET',base..':jobs',ARGV[1],raw)
redis.call('ZADD',base..':leases',expires,ARGV[1])
redis.call('INCR',base..':version')
return 1
'''

UPDATE = _PATCH + r'''
local incoming=cjson.decode(ARGV[1])
local old_raw=redis.call('HGET',base..':jobs',incoming.id)
if not old_raw then return 0 end
local old=cjson.decode(old_raw)
if old.state~='active' or old.lease_token~=incoming.lease_token or old.lease_expires_at==cjson.null or old.lease_expires_at<=now then return 0 end
if redis.call('SCARD',base..':children')>0 then return 2 end
local policy=false
if incoming.state=='completed' then policy=incoming.opts.remove_on_complete
elseif incoming.state=='failed' then policy=incoming.opts.remove_on_fail end
if type(policy)=='number' then return 2 end
local function encode_key(value)
  return (string.gsub(value,'([^%w%-_%.~])',function(c) return string.format('%%%02X',string.byte(c)) end))
end
local position=redis.call('ZSCORE',base..':sequence',incoming.id)
local member=string.format('%020d',tonumber(position))..':'..incoming.id
redis.call('ZREM',base..':status:active',incoming.id)
redis.call('ZREM',base..':leases',incoming.id)
if old.opts.deduplication_key~=cjson.null then redis.call('SREM',base..':dedup:'..encode_key(old.opts.deduplication_key),incoming.id) end
if policy==true then
  redis.call('HDEL',base..':jobs',incoming.id)
  redis.call('ZREM',base..':sequence',incoming.id)
else
  local raw=ARGV[1]
  if incoming.state=='active' then
    raw=patch(raw,'lease_expires_at',tostring(now+tonumber(ARGV[2])))
    redis.call('ZADD',base..':leases',now+tonumber(ARGV[2]),incoming.id)
  end
  redis.call('HSET',base..':jobs',incoming.id,raw)
  redis.call('ZADD',base..':status:'..incoming.state,position,incoming.id)
  if incoming.state=='waiting' or incoming.state=='delayed' then
    local due=incoming.available_at
    if due==cjson.null then due=incoming.timestamp+incoming.delay end
    if due<=now then redis.call('ZADD',base..':ready',incoming.opts.priority,member)
    else redis.call('ZADD',base..':due',due,member) end
  end
  if incoming.state~='completed' and incoming.state~='failed' and incoming.opts.deduplication_key~=cjson.null then
    redis.call('SADD',base..':dedup:'..encode_key(incoming.opts.deduplication_key),incoming.id)
  end
end
if incoming.state=='failed' then redis.call('HSET',base..':dlq',incoming.id,ARGV[3]) end
redis.call('INCR',base..':version')
return 1
'''
