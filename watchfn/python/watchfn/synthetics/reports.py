"""Stored synthetic reports; missing history is never successful uptime."""
from copy import deepcopy
import math
from ..business.stored_funnels import FunnelQuery,funnel_timestamp,text,packed
from ..query import number
from .checks import duration


def results(storage,app,options,history=False):
    if not isinstance(options,dict) or not text(options.get('checkId'),256):raise ValueError('Invalid synthetic check ID')
    query=FunnelQuery({'timeRange':options.get('timeRange','last-24h'),'limit':10000})
    start,end=query.range
    if not number(start) or not number(end) or max(abs(start),abs(end))>8640000000000000:raise ValueError('Invalid synthetic report range')
    events=storage.query('synthetics.check')
    if len(events)>10000:raise ValueError('Synthetic report scan count exceeded')
    size=0;rows=[];runs={}
    for event in events:
        raw=event.model_dump(mode='json');length=len(packed(raw).encode());size+=length
        if length>65536 or size>16777216:raise ValueError('Synthetic report scan bytes exceeded')
        at=funnel_timestamp(event.timestamp)
        if at>end or not history and at<start or event.type!='track':continue
        value=raw.get('properties',{})
        if value.get('checkId')!=options['checkId']:continue
        owner=raw.get('app')
        if not isinstance(owner,dict) or not text(owner.get('name')):raise ValueError('Legacy synthetic result has no application ownership; explicit migration required')
        if owner['name']!=app:continue
        if type(value.get('success')) is not bool or not number(value.get('timestamp')) or not number(value.get('duration')) or value['duration']<0:raise ValueError('Invalid stored synthetic result')
        if 'runId' in value:
            identifier=value['runId']
            if not text(identifier,256):raise ValueError('Invalid synthetic run identity')
            signature=(at,value['success'],value['duration'])
            if identifier in runs:
                if runs[identifier]!=signature:raise ValueError('Conflicting synthetic run results')
                continue
            runs[identifier]=signature
        rows.append(dict(value,timestamp=at))
    rows.sort(key=lambda row:(row['timestamp'],row.get('runId','')))
    for previous,current in zip(rows,rows[1:]):
        if previous['timestamp']==current['timestamp'] and previous['success']!=current['success']:raise ValueError('Ambiguous simultaneous synthetic outcomes')
    return {'from':start,'to':end},rows


def uptime(storage,app,options):
    bounds,rows=results(storage,app,options);successful=sum(row['success'] for row in rows)
    return dict(checkId=options['checkId'],timeRange=bounds,basis='completed-checks',observed=bool(rows),total=len(rows),successful=successful,failed=len(rows)-successful,uptime=successful/len(rows)*100 if rows else None)


def incidents(storage,app,options):
    if options.get('status') not in (None,'active','resolved'):raise ValueError('Invalid incident status')
    bounds,rows=results(storage,app,options,True);output=[];active=None
    for index,row in enumerate(rows):
        if not row['success']:
            if active is None:
                active=dict(checkId=options['checkId'],startedAt=row['timestamp'],resolvedAt=None,status='active',failures=0,leftCensored=index==0);output.append(active)
            active['failures']+=1
        elif active is not None:
            active.update(resolvedAt=row['timestamp'],status='resolved');active=None
    return [row for row in output if (row['resolvedAt'] is None or row['resolvedAt']>=bounds['from']) and row['startedAt']<=bounds['to'] and (not options.get('status') or row['status']==options['status'])]


def trend(storage,app,options):
    if options.get('metric')!='responseTime':raise ValueError('Only responseTime synthetic trend is supported')
    bounds,rows=results(storage,app,options);interval=duration(options.get('interval','1h'))
    count=max(1,math.ceil((bounds['to']-bounds['from'])/interval))
    if count>10000:raise ValueError('Synthetic report bucket capacity exceeded')
    buckets=[dict(from_=bounds['from']+index*interval,to=min(bounds['to'],bounds['from']+(index+1)*interval),count=0,successful=0,failed=0,total=0,min=None,max=None) for index in range(count)]
    for bucket in buckets:bucket['from']=bucket.pop('from_')
    for row in rows:
        bucket=buckets[min(count-1,math.floor((row['timestamp']-bounds['from'])/interval))]
        bucket['count']+=1;bucket['successful' if row['success'] else 'failed']+=1;bucket['total']+=row['duration']
        if not math.isfinite(bucket['total']):raise ValueError('Synthetic duration aggregate overflow')
        bucket['min']=min(bucket['min'] if bucket['min'] is not None else row['duration'],row['duration']);bucket['max']=max(bucket['max'] if bucket['max'] is not None else row['duration'],row['duration'])
    for bucket in buckets:bucket['average']=bucket.pop('total')/bucket['count'] if bucket['count'] else None;bucket.pop('total',None)
    return dict(checkId=options['checkId'],metric='responseTime',timeRange=bounds,interval=interval,buckets=buckets)
