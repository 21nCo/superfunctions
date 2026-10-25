from datetime import datetime, timezone
import pytest
from watchfn import WatchFn
from watchfn.models import Event
from watchfn.log_patterns import pattern_tokens, discover_patterns


def test_stored_discovery_and_stopped_lifecycle():
    watch = WatchFn('patterns')
    watch.system_metrics.start = lambda: None
    watch.process_metrics.start = lambda: None
    with pytest.raises(RuntimeError, match='unavailable'):
        watch.logs.detect_patterns({'fields': ['message'], 'minOccurrences': 2})
    watch.start()
    try:
        for message in ['order 123 failed', 'order 456 failed', 'order 789 accepted']:
            watch.storage.add(Event(type='log', timestamp=datetime(2026, 10, 25, tzinfo=timezone.utc), properties={'message': message}))
        result = watch.logs.detectPatterns({'fields': ['message'], 'minOccurrences': 2})
        assert len(result) == 1 and result[0]['pattern'] == 'order <number> failed' and result[0]['count'] == 2
        assert result[0]['firstSeen'] == '2026-10-25T00:00:00.000Z'
    finally:
        watch.stop()


def test_discovery_rejects_duplicate_fields_and_invalid_scalars():
    for options in [{'fields': ['message', 'message']}, {'minOccurrences': True}, {'minOccurrences': 0}, {'unknown': 1}, {'timeRange':None}]:
        with pytest.raises(ValueError):
            discover_patterns([], options)
    with pytest.raises(ValueError):
        pattern_tokens('\ud800')


import json
from pathlib import Path

def test_shared_template_and_id_vectors():
    vectors = json.loads((Path(__file__).parent / 'fixtures/log-pattern-golden.json').read_text())
    for vector in vectors:
        events=[]
        for value in vector['values']:
            assert pattern_tokens(value) == vector['tokens']
            events.append(Event(type='log', properties={'message':value}))
        result=discover_patterns(events,{'fields':[vector['field']],'minOccurrences':1})
        assert len(result)==1 and result[0]['id']==vector['id'] and result[0]['count']==len(events)


def test_scan_limit_fails_without_partial_counts():
    events=(Event(type='log',properties={'message':'repeated'}) for _ in range(10001))
    with pytest.raises(ValueError,match='event limit'):
        discover_patterns(events,{'minOccurrences':1})


def test_actual_logger_patterns_survive_sqlite_reopen(tmp_path):
    from sqlalchemy import create_engine
    from superfunctions_sqlalchemy import create_adapter
    from logfn import create_logger
    from test_database import migrate
    from test_log_integration import migrate_index
    url='sqlite:///' + str(tmp_path / 'patterns.sqlite')
    engine=create_engine(url)
    migrate(engine);migrate_index(engine)
    def start(engine):
        watch=WatchFn('patterns',storage='database',database=create_adapter(engine))
        watch.system_metrics.start=lambda:None
        watch.process_metrics.start=lambda:None
        watch.start()
        return watch
    watch=start(engine)
    try:
        logger=create_logger(name='orders',sinks=[lambda batch:None])
        watch.use(logger)
        logger.info('order 123 failed');logger.info('order 456 failed')
        before=watch.logs.detect_patterns({'fields':['message'],'minOccurrences':2})
        assert len(before)==1 and before[0]['count']==2
    finally:
        watch.stop();engine.dispose()
    engine=create_engine(url);watch=start(engine)
    try:
        assert watch.logs.detect_patterns({'fields':['message'],'minOccurrences':2})==before
    finally:
        watch.stop();engine.dispose()


def test_pattern_counts_include_more_than_public_query_result_limit():
    events=[Event(type='log',properties={'message':f'order {index} failed'}) for index in range(1001)]
    result=discover_patterns(events,{'minOccurrences':1001})
    assert len(result)==1 and result[0]['count']==1001
