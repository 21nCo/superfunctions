"""HTTP check validation and one deadline covering headers and decoded body."""
import asyncio
from copy import deepcopy
import re
import time
from urllib.parse import urlsplit
from ..business.stored_funnels import text
from ..query import number


def duration(value):
    match = re.fullmatch(r'(\d+)(ms|s|m|h|d)', value) if isinstance(value,str) else None
    result = value if type(value) is int else int(match[1])*{'ms':1,'s':1000,'m':60000,'h':3600000,'d':86400000}[match[2]] if match else None
    if type(result) is not int or not 10 <= result <= 2147483647:raise ValueError('Synthetic interval must be 10ms through 2147483647ms')
    return result


def validate(source):
    if not isinstance(source,dict) or source.get('type')!='http':raise ValueError('Synthetic browser execution is unavailable; only HTTP checks are supported')
    value=deepcopy(source)
    if not text(value.get('name'),256) or 'id' in value and not text(value['id'],256):raise ValueError('Invalid synthetic identity')
    if 'locations' in value or 'alerts' in value:raise ValueError('Synthetic locations and consecutive-failure alerts are not implemented')
    url=value.get('url')
    if not isinstance(url,str) or len(url.encode())>4096:raise ValueError('Invalid synthetic URL')
    parsed=urlsplit(url)
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password:raise ValueError('Invalid synthetic HTTP URL')
    value.setdefault('method','GET')
    if value['method'] not in ('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'):raise ValueError('Invalid synthetic HTTP method')
    for key,default,minimum,maximum in [('timeout',5000,1,300000),('retries',0,0,5),('maxResponseBytes',1048576,1,16777216)]:
        value.setdefault(key,default)
        if type(value[key]) is not int or not minimum <= value[key] <= maximum:raise ValueError('Invalid synthetic timeout, retries or response limit')
    headers=value.get('headers',{})
    if not isinstance(headers,dict) or len(headers)>100:raise ValueError('Invalid synthetic headers')
    size=0
    for key,item in headers.items():
        if not isinstance(key,str) or not isinstance(item,str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+",key) or '\r' in item or '\n' in item or len(key)+len(item)>8192:raise ValueError('Invalid synthetic headers')
        size+=len(key.encode())+len(item.encode())
    if size>16384:raise ValueError('Synthetic headers exceed 16KiB aggregate')
    assertions=value.get('assertions',[])
    if not isinstance(assertions,list) or len(assertions)>100:raise ValueError('Invalid synthetic assertions')
    for assertion in assertions:
        if not isinstance(assertion,dict) or assertion.get('type') not in ('status','responseTime','body','header') or assertion.get('operator') not in ('eq','lt','gt','contains'):raise ValueError('Invalid synthetic assertion')
        kind,operator,expected=assertion['type'],assertion['operator'],assertion.get('value')
        if kind in ('status','responseTime'):
            if not number(expected) or operator=='contains':raise ValueError('Invalid numeric synthetic assertion')
        elif not isinstance(expected,str) or len(expected.encode('utf-16-le'))//2>16384 or operator not in ('eq','contains') or kind=='header' and not text(assertion.get('key'),8192):raise ValueError('Invalid textual synthetic assertion')
    value['interval']=duration(value.get('interval'));value['id']=value.get('id',value['name'])
    return value


class CheckFailure(Exception):pass


async def run(check, httpx, redact):
    started=int(time.time()*1000);begin=time.monotonic()
    async def request():
        async with httpx.AsyncClient(follow_redirects=True,timeout=None,trust_env=False) as client:
            async with client.stream(check['method'],check['url'],headers=check.get('headers')) as response:
                chunks=[];size=0
                async for chunk in response.aiter_bytes():
                    size+=len(chunk)
                    if size>check['maxResponseBytes']:raise CheckFailure('Synthetic response byte limit exceeded')
                    chunks.append(chunk)
                elapsed=(time.monotonic()-begin)*1000
                if elapsed>=check['timeout']:raise CheckFailure('Synthetic HTTP deadline exceeded')
                body=b''.join(chunks).decode('utf-8',errors='replace')
                for assertion in check.get('assertions',[]):
                    actual=response.status_code if assertion['type']=='status' else elapsed if assertion['type']=='responseTime' else body if assertion['type']=='body' else response.headers.get(assertion['key'])
                    expected,operator=assertion['value'],assertion['operator']
                    passed=actual==expected if operator=='eq' else isinstance(actual,str) and expected in actual if operator=='contains' else number(actual) and (actual<expected if operator=='lt' else actual>expected)
                    if not passed:raise CheckFailure('Assertion failed: '+assertion['type']+' '+operator)
                return dict(status=response.status_code,headers=redact(dict(response.headers)),bodySize=size)
    result=dict(checkId=check['id'],checkName=check['name'],startedAt=started)
    try:
        response=await asyncio.wait_for(request(),check['timeout']/1000)
        result.update(success=True,response=response)
    except asyncio.CancelledError:raise
    except asyncio.TimeoutError:result.update(success=False,error='Synthetic HTTP deadline exceeded')
    except Exception as error:result.update(success=False,error=str(error) if isinstance(error,CheckFailure) else 'Synthetic HTTP request failed')
    result.update(timestamp=int(time.time()*1000),duration=(time.monotonic()-begin)*1000)
    return result
