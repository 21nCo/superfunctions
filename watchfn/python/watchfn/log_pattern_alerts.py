"""Native Python regex alerts with owned, deadline-bounded subprocess evaluation."""
from copy import deepcopy
import json
import re
import subprocess
import sys
import threading

from .query import QueryValidationError, read
from .log_patterns import stored_log_rows

_MAX_SOURCE = 4096
_ALLOWED_FLAGS = int(re.I | re.M | re.S | re.A | re.U)
_slots = threading.BoundedSemaphore(4)
_WORKER = r'''
import json, re, sys
try:
    value=json.load(sys.stdin)
    pattern=re.compile(value['source'],value['flags'])
    count=sum(pattern.search(text) is not None for text in value['values'])
    print(json.dumps({'count':count}))
except BaseException:
    print('{"error":true}')
'''


def validate_pattern(pattern):
    if (not isinstance(pattern, dict) or set(pattern) != {'engine', 'source', 'flags'}
            or pattern.get('engine') != 'python-re' or type(pattern.get('source')) is not str
            or type(pattern.get('flags')) is not int or pattern['flags'] < 0
            or pattern['flags'] & ~_ALLOWED_FLAGS):
        raise ValueError('Invalid native Python log pattern')
    try:
        if len(pattern['source'].encode('utf-8')) > _MAX_SOURCE:
            raise ValueError('Log pattern source exceeds capacity')
    except UnicodeEncodeError:
        raise ValueError('Invalid log pattern Unicode') from None


def bounded_match_count(pattern, values):
    validate_pattern(pattern)
    if not isinstance(values, list) or len(values) > 10000:
        raise ValueError('Log pattern input count exceeded')
    size=0
    for value in values:
        if not isinstance(value, str):
            raise ValueError('Invalid log pattern input')
        try:
            length=len(value.encode('utf-8'))
        except UnicodeEncodeError:
            raise ValueError('Invalid log pattern input Unicode') from None
        size+=length
        if length>16384 or size>16*1024*1024:
            raise ValueError('Log pattern input bytes exceeded')
    if not _slots.acquire(blocking=False):
        raise RuntimeError('Log pattern worker capacity exceeded')
    process = None
    try:
        payload = json.dumps({'source':pattern['source'],'flags':pattern['flags'],'values':values},ensure_ascii=False).encode('utf-8')
        if len(payload) > 17 * 1024 * 1024:
            raise ValueError('Log pattern input exceeds capacity')
        process = subprocess.Popen([sys.executable, '-I', '-c', _WORKER], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            output, _ = process.communicate(payload, timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise RuntimeError('Log pattern execution deadline exceeded') from None
        if process.returncode != 0 or len(output) > 128:
            raise RuntimeError('Log pattern worker failed')
        result = json.loads(output)
        if type(result) is not dict or set(result) != {'count'} or type(result['count']) is not int or not 0 <= result['count'] <= len(values):
            raise ValueError('Invalid log pattern or worker response')
        return result['count']
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.communicate()
        _slots.release()


def count_log_pattern(events, condition, start, now, maximum):
    values = []
    rows = stored_log_rows(events, {'from':start,'to':now})
    if len(rows) > min(maximum, 10000):
        raise QueryValidationError('Log pattern observation capacity exceeded')
    for row in rows:
        value = read(row, condition['field'])
        if not isinstance(value, str):
            continue
        try:
            if len(value.encode('utf-8')) > 16384:
                raise QueryValidationError('Log pattern field capacity exceeded')
        except UnicodeEncodeError:
            raise QueryValidationError('Invalid log pattern field Unicode') from None
        values.append(value)
    return bounded_match_count(condition['pattern'], values)


def _create_pattern(watch, options):
    if not watch.is_started:
        raise RuntimeError('WatchFn storage is unavailable')
    if not isinstance(options, dict) or set(options) - {'name','pattern','threshold','alert'}:
        raise ValueError('Invalid log pattern definition')
    name = options.get('name')
    compiled = options.get('pattern')
    threshold = options.get('threshold')
    alert = options.get('alert', {})
    if not isinstance(name, str) or not name.strip() or len(name) > 255 or not isinstance(compiled, re.Pattern) or not isinstance(compiled.pattern, str):
        raise ValueError('Invalid log pattern name or compiled expression')
    if (not isinstance(threshold, dict) or set(threshold) != {'count','window'}
            or type(threshold.get('count')) is not int or not 1 <= threshold['count'] <= 10000):
        raise ValueError('Invalid log pattern threshold')
    if not isinstance(alert, dict) or set(alert) - {'enabled','severity','channels'}:
        raise ValueError('Invalid log pattern alert options')
    enabled=alert.get('enabled', True)
    severity=alert.get('severity','warning')
    names=alert.get('channels', [])
    if type(enabled) is not bool or severity not in ('info','warning','error','critical') or not isinstance(names,list) or len(names)>10 or any(type(name) is not str for name in names) or len(set(names))!=len(names):
        raise ValueError('Invalid log pattern alert options')
    channels=[]
    for alias in names:
        if alias not in watch.config.alerts.named_channels:
            raise ValueError('Unknown log pattern alert channel')
        channels.append(deepcopy(watch.config.alerts.named_channels[alias]))
    condition={'type':'log-pattern','field':'message','pattern':{'engine':'python-re','source':compiled.pattern,'flags':int(compiled.flags)},
        'threshold':threshold['count'],'window':threshold['window'],'operator':'gte'}
    from .alerts.observations import validate
    validate(condition)
    bounded_match_count(condition['pattern'], [])
    return watch.alerts.create({'name':name,'condition':condition,'channels':channels,'enabled':enabled,'severity':severity})


def create_pattern(watch, options):
    if not watch.is_started:
        raise RuntimeError('WatchFn storage is unavailable')
    # Include registration validation workers in the existing lifecycle drain.
    with watch.alerts._callbacks.operation():
        return _create_pattern(watch, options)
