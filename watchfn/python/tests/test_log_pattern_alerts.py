import re
from datetime import datetime, timezone
from watchfn import WatchFn
from watchfn.models import Event


def test_log_pattern_registers_and_evaluates_stored_memory():
    watch=WatchFn('patterns')
    watch.system_metrics.start=lambda:None
    watch.process_metrics.start=lambda:None
    watch.start()
    try:
        pattern=watch.logs.create_pattern({'name':'failed-auth','pattern':re.compile('authentication failed',re.I),
            'threshold':{'count':2,'window':'5m'},'alert':{'enabled':True,'channels':[]}})
        for text in ['Authentication failed','authentication failed','successful']:
            watch.storage.add(Event(type='log',timestamp=datetime(2026,10,25,10,tzinfo=timezone.utc),properties={'message':text}))
        results=watch.alerts.evaluate_stored(now=1792922400000)
        assert len(results)==1 and results[0].matched is True and results[0].value==2
    finally:
        watch.stop()
        if watch.alerts._engine is not None:watch.alerts._engine.dispose()


import json
import subprocess
import time
import pytest
from test_alert_dispatch import endpoint  # noqa: F401
from test_durable_alerts import open_watch, migrate_alerts
from test_database import migrate
from watchfn.log_pattern_alerts import bounded_match_count


def definition(pattern=None, channels=None):
    return {'name':'auth','pattern':pattern or re.compile('authentication failed',re.I),
        'threshold':{'count':2,'window':'5m'},'alert':{'enabled':True,'severity':'warning','channels':channels or []}}


def test_pattern_survives_sqlite_reopen_and_delivers_named_channel(tmp_path, endpoint):
    url,state=endpoint
    path='sqlite:///'+str(tmp_path/'patterns.sqlite')
    options={'alerts':{'namedChannels':{'ops':{'type':'webhook','webhook':url}}}}
    engine,watch=open_watch(path,**options)
    migrate(engine);migrate_alerts(engine)
    try:
        record=watch.logs.createPattern(definition(channels=['ops']))
        identifier=record['id']
        assert 'private-token' not in json.dumps(record)
        assert record['condition']['pattern']['engine']=='python-re'
        for text,when in [('authentication failed','2026-10-25T10:00:00+00:00'),('AUTHENTICATION FAILED','2026-10-25T10:01:00+00:00'),('authentication failed','2026-10-25T09:00:00+00:00')]:
            watch.storage.add(Event(type='log',timestamp=datetime.fromisoformat(when),properties={'message':text}))
    finally: watch.stop();engine.dispose()
    engine,watch=open_watch(path,**options)
    try:
        result=watch.alerts.evaluate_stored(now=datetime(2026,10,25,10,2,tzinfo=timezone.utc).timestamp()*1000)
        assert len(result)==1 and result[0].matched is True and result[0].value==2
        assert watch.alerts.get_record(identifier)['state']=='triggered'
        assert watch.alerts.process_notifications()['processed']==1
        assert len(state['requests'])==1
        notification=state['requests'][0]['body']
        assert notification['value']==2 and notification['threshold']==2
        assert watch.alerts.process_notifications()['processed']==0
    finally: watch.stop();engine.dispose()


def test_zero_is_observed_and_invalid_registration_does_not_persist():
    watch=WatchFn('zero')
    watch.system_metrics.start=lambda:None;watch.process_metrics.start=lambda:None
    with pytest.raises(RuntimeError):watch.logs.create_pattern(definition())
    watch.start()
    try:
        for bad in [definition(channels=['missing']),dict(definition(),pattern=re.compile(b'bytes')),dict(definition(),threshold={'count':True,'window':'5m'})]:
            with pytest.raises(ValueError):watch.logs.create_pattern(bad)
        record=watch.logs.create_pattern(definition())
        result=watch.alerts.evaluate_stored()
        assert len(result)==1 and result[0].observed and result[0].matched is False and result[0].value==0
        assert watch.alerts.get_record(record['id'])['state']=='normal'
        assert watch.alerts.notifications()==[]
        from logfn import create_logger
        logger=create_logger(name='actual-pattern-producer',sinks=[lambda batch:None])
        watch.use(logger)
        logger.error('Authentication failed');logger.error('authentication failed')
        assert watch.alerts.evaluate_stored()[0].matched is True
    finally:
        watch.stop()
        if watch.alerts._engine is not None:watch.alerts._engine.dispose()


def test_native_regex_timeout_joins_child_and_preserves_alert_state(monkeypatch):
    processes=[]
    original=subprocess.Popen
    def spawn(*args,**kwargs):
        process=original(*args,**kwargs);processes.append(process);return process
    monkeypatch.setattr('watchfn.log_pattern_alerts.subprocess.Popen',spawn)
    watch=WatchFn('timeout')
    watch.system_metrics.start=lambda:None;watch.process_metrics.start=lambda:None
    watch.start()
    try:
        record=watch.logs.create_pattern(definition(re.compile('(a+)+$')))
        watch.storage.add(Event(type='log',timestamp=datetime.now(timezone.utc),properties={'message':'a'*10000+'!'}))
        before=time.monotonic()
        with pytest.raises(RuntimeError,match='deadline'):
            watch.alerts.evaluate_stored()
        assert time.monotonic()-before<5
        assert all(process.poll() is not None for process in processes)
        assert watch.alerts.get_record(record['id'])['state']=='normal'
        assert watch.alerts.notifications()==[]
    finally:watch.stop();watch.alerts._engine.dispose()


def test_regex_input_and_engine_limits():
    pattern={'engine':'python-re','source':'a','flags':0}
    with pytest.raises(ValueError):bounded_match_count(dict(pattern,engine='ecmascript'),[])
    with pytest.raises(ValueError):bounded_match_count(dict(pattern,flags=int(re.DEBUG)),[])
    with pytest.raises(ValueError):bounded_match_count(pattern,['a']*10001)
    with pytest.raises(ValueError):bounded_match_count(pattern,['a'*16385])
    with pytest.raises(ValueError):bounded_match_count(pattern,['\ud800'])
    with pytest.raises(ValueError):bounded_match_count(dict(pattern,source='('),[])


def test_pattern_observation_capacity_rejects_without_transition():
    watch=WatchFn('capacity')
    watch.system_metrics.start=lambda:None;watch.process_metrics.start=lambda:None
    watch.start()
    try:
        record=watch.logs.create_pattern(definition())
        for _ in range(2):watch.storage.add(Event(type='log',timestamp=datetime.now(timezone.utc),properties={'message':'authentication failed'}))
        with pytest.raises(ValueError,match='capacity'):watch.alerts.evaluate_stored(maximum=1)
        assert watch.alerts.get_record(record['id'])['state']=='normal'
    finally:watch.stop();watch.alerts._engine.dispose()


def test_stop_drains_admitted_pattern_registration(monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from watchfn import log_pattern_alerts
    original=log_pattern_alerts.bounded_match_count
    entered,release=threading.Event(),threading.Event()
    def blocked(pattern,values):
        entered.set()
        assert release.wait(5)
        return original(pattern,values)
    monkeypatch.setattr(log_pattern_alerts,'bounded_match_count',blocked)
    watch=WatchFn('registration-drain')
    watch.system_metrics.start=lambda:None;watch.process_metrics.start=lambda:None
    watch.start()
    try:
        with ThreadPoolExecutor(2) as pool:
            registration=pool.submit(watch.logs.create_pattern,definition())
            assert entered.wait(5)
            stopped=pool.submit(watch.stop)
            assert not stopped.done()
            release.set()
            record=registration.result(timeout=5)
            stopped.result(timeout=5)
        watch.start()
        assert watch.alerts.get_record(record['id'])['state']=='normal'
    finally:
        release.set();watch.stop()
        if watch.alerts._engine is not None:watch.alerts._engine.dispose()


def test_rejected_callback_stop_keeps_log_attachment_active():
    from logfn import create_logger
    watch=WatchFn('callback-stop')
    watch.system_metrics.start=lambda:None;watch.process_metrics.start=lambda:None
    watch.start()
    logger=create_logger(name='still-attached',sinks=[lambda batch:None]);watch.use(logger)
    try:
        record=watch.logs.create_pattern(definition())
        def callback(record,context):
            with pytest.raises(RuntimeError,match='callback'):watch.stop()
        watch.alerts.on_trigger(callback)
        watch.alerts.trigger(record['id'])
        assert watch.is_started
        logger.info('after rejected stop')
        assert len(watch.logs.query({'search':'after rejected stop'}))==1
    finally:watch.stop();watch.alerts._engine.dispose()
