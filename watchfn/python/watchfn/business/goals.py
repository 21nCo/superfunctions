"""UTC anchored goal-v1 progress and pace over canonical retained events."""
from datetime import datetime, timezone, timedelta
from calendar import monthrange
from copy import deepcopy
import hashlib
import json
import math
import re
from .stored_funnels import text, field, packed, FunnelQuery, funnel_timestamp
from ..query import read, number


def goal_id(app, name, kind='goal'):
    if not text(app) or not text(name):raise ValueError('Invalid business identity')
    return hashlib.sha256(packed([app, kind, name]).encode()).hexdigest()


def validate_goal(source):
    if (not isinstance(source, dict) or set(source) - {'name','target','metric','aggregation','period','startDate','timezone','alerts'}
        or not text(source.get('name')) or not number(source.get('target')) or source['target'] <= 0
        or source.get('aggregation') not in ('sum','count','avg','min','max') or source.get('period') not in ('day','week','month','year')
        or source.get('timezone', 'UTC') != 'UTC'): raise ValueError('Invalid business goal')
    value = deepcopy(source)
    start = value.get('startDate')
    if not isinstance(start, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', start) or int(start[:4]) < 1000: raise ValueError('Invalid UTC goal startDate')
    datetime.fromisoformat(start)
    metric = value.get('metric')
    if isinstance(metric, str):
        event, separator, path = metric.rpartition('.')
        metric = {'event': event if separator else '', 'field': path}
    if not isinstance(metric, dict) or set(metric) != {'event','field'} or not text(metric['event']): raise ValueError('Goal metric requires event and field')
    field(metric['field'])
    value['metric'], value['timezone'] = metric, 'UTC'
    if 'alerts' in value:
        alert = value['alerts']
        if (not isinstance(alert, dict) or set(alert) != {'on_track_check','notify_below_pace','channels'}
            or type(alert['notify_below_pace']) is not bool or not isinstance(alert['on_track_check'], str)
            or not re.fullmatch(r'\d+(?:\.\d+)?%', alert['on_track_check']) or not 0 <= float(alert['on_track_check'][:-1]) <= 100
            or not isinstance(alert['channels'], list) or len(alert['channels']) > 10 or len(set(alert['channels'])) != len(alert['channels']) or any(not text(name, 128) for name in alert['channels'])): raise ValueError('Invalid goal pace alerts')
    if len(packed(value).encode()) > 16384: raise ValueError('Goal definition too large')
    return value


def goal_date(value):
    if isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value): value += 'T00:00:00Z'
    at=funnel_timestamp(value)
    if not  -30610224000000 <= at <= 253402300799999:raise ValueError('Invalid goal date')
    return at


def goal_period(config, now):
    start = datetime.fromisoformat(config['startDate']).replace(tzinfo=timezone.utc)
    epoch = funnel_timestamp(start)
    if now < epoch: raise ValueError('Goal date precedes startDate')
    if config['period'] in ('day','week'):
        duration = (1 if config['period'] == 'day' else 7) * 86400000
        first = epoch + math.floor((now-epoch)/duration)*duration
        if first+duration>253402300799999:raise ValueError('Goal period exceeds supported calendar')
        return first, first+duration
    step = 1 if config['period'] == 'month' else 12
    def bound(index):
        total = start.year*12+start.month-1+index*step
        year, month = divmod(total, 12)
        return funnel_timestamp(datetime(year, month+1, min(start.day, monthrange(year, month+1)[1]), tzinfo=timezone.utc))
    current = datetime(1970,1,1,tzinfo=timezone.utc)+timedelta(milliseconds=now)
    index = ((current.year-start.year)*12+current.month-start.month)//step
    if bound(index)>now: index-=1
    return bound(index),bound(index+1)


def progress(events, app, source, date, maximum=10000):
    goal=validate_goal(source);now=goal_date(date);start,end=goal_period(goal,now)
    if len(events)>min(maximum,10000): raise ValueError('Goal observation capacity exceeded')
    total=0
    for event in events:
        size=len(event.model_dump_json().encode());total+=size
        if size>65536 or total>16777216: raise ValueError('Goal observation capacity exceeded')
    rows=FunnelQuery({'where':{'type':'track'},'timeRange':{'from':start,'to':now},'limit':10000}).execute(events)
    values=[]
    for row in rows:
        if row.get('name')!=goal['metric']['event']:continue
        app_value=row.get('app')
        if not isinstance(app_value,dict) or not text(app_value.get('name')):raise ValueError('Business event ownership missing; migration required')
        if app_value['name']!=app:continue
        value=1 if goal['aggregation']=='count' else read(row,goal['metric']['field'])
        if not number(value):raise ValueError('Goal event requires finite numeric value')
        values.append(float(value))
    observed=bool(values) or goal['aggregation'] in ('sum','count');actual=None
    if observed:
        if goal['aggregation']=='count':actual=len(values)
        elif goal['aggregation']=='min':actual=min(values)
        elif goal['aggregation']=='max':actual=max(values)
        else:
            actual=0.0
            for value in values:actual+=value/len(values) if goal['aggregation']=='avg' else value
        if not math.isfinite(actual):raise ValueError('Goal aggregate overflow')
    if actual is not None and not math.isfinite(actual/goal['target']*100):raise ValueError('Goal progress overflow')
    elapsed=(now-start)/(end-start);expected=goal['target']*elapsed
    eligible=elapsed*100>=float(goal.get('alerts',{}).get('on_track_check','0%')[:-1])
    return dict(name=goal['name'],date=now,periodStart=start,periodEnd=end,actual=actual,target=goal['target'],progressPercent=None if actual is None else actual/goal['target']*100,elapsedPercent=elapsed*100,expected=expected,belowPace=None if not eligible or actual is None else actual<expected,observed=observed,eventCount=len(values))


def goal_key(condition):return ('business-goal',condition['app'],packed(condition['goal']))
