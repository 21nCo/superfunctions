import asyncio
import threading

import pytest
from logfn import create_logger
from watchfn import WatchFn


def watch(**kwargs):
    result = WatchFn('logs', **kwargs)
    result.system_metrics.start = lambda: None
    result.process_metrics.start = lambda: None
    return result


def logger(**kwargs):
    return create_logger(name='api', sinks=[lambda events: None], level='trace', **kwargs)


def test_actual_logger_family_lifecycle_queries_and_canonical_fields():
    w, log = watch(), logger()
    child = log.child()
    detach = w.use(log)
    assert w.use(log) is detach
    log.info('before')
    w.start()
    try:
        child.info('Payment failed', {'service': 'payments', 'type': 'error', 'timestamp': 'spoof', 'level': 'fatal'})
        row = w.logs.query({'level': 'info', 'search': 'Payment', 'filters': {'service': 'payments'}})[0]
        assert row['type'] == 'log' and row['name'] == 'api'
        assert row['properties']['level'] == 'info'
        assert 'timestamp' not in row['properties']
        assert w.logs.aggregate({'groupBy': ['level'], 'aggregation': 'count'})[0]['value'] == 1
        with pytest.raises(ValueError, match='Detach'): w.use(log, {'minLevel': 'error'})
        w.stop(); log.info('stopped'); w.start(); log.error('after restart')
        assert len(w.logs.query({})) == 2
        detach(); detach(); w.stop(); w.start(); log.error('detached')
        assert len(w.logs.query({})) == 2
    finally: w.stop()


def test_options_config_redaction_and_structured_json():
    w = watch(integrations={'logfn': {'minLevel': 'error'}})
    log = logger()
    w.use(log, {'minLevel': 'info'})
    w.start()
    try:
        log.debug('excluded')
        log.info('{"userId":"private-user","order":"ok"}', {'userId': 'ctx-user'})
        row = w.logs.query({})[0]
        assert row['properties']['userId'] == '[redacted]'
        assert row['properties']['order'] == 'ok'
        assert 'ctx-user' not in str(row)
        assert 'private-user' not in str(row)
        # Structured fields do not override the producer's message/level/service.
        assert row['properties']['service'] == 'api'
    finally: w.stop()


def test_stop_joins_synchronous_admitted_sink_and_storage_error_is_not_acknowledged():
    w, log = watch(), logger()
    w.use(log); w.start()
    admitted, release, stopped = threading.Event(), threading.Event(), threading.Event()
    original = w.storage.add_batch
    def held(events):
        admitted.set(); assert release.wait(3); original(events)
    w.storage.add_batch = held
    worker = threading.Thread(target=lambda: log.info('owned'))
    worker.start(); assert admitted.wait(3)
    stopper = threading.Thread(target=lambda: (w.stop(), stopped.set()))
    stopper.start(); assert not stopped.wait(.05)
    release.set(); worker.join(3); stopper.join(3)
    assert not worker.is_alive() and not stopper.is_alive()
    assert len(w.storage.query()) == 1
    w.start()
    def failed(events): raise RuntimeError('storage failed')
    w.storage.add_batch = failed
    log.info('retryable')
    with pytest.raises(RuntimeError, match='storage failed'): asyncio.run(log.flush())
    with pytest.raises(RuntimeError, match='storage failed'): w.flush()
    w.storage.add_batch = original
    w.flush(); w.stop()
    assert len(w.storage.query()) == 2


def test_disabled_validation_and_reentrant_stop():
    w, log = watch(), logger()
    w.use(log, {'enabled': False}); w.start()
    try:
        log.info('off'); assert w.logs.query({}) == []
        with pytest.raises(ValueError): w.logs.query({'filters': {'type': 'track'}})
        with pytest.raises(ValueError): w.logs.query({'search': 'x', 'filters': {'message': 'x'}})
    finally: w.stop()
    w, log = watch(), logger(); w.use(log); w.start()
    original = w.storage.add_batch
    w.storage.add_batch = lambda events: w.stop()
    log.info('reentrant')
    with pytest.raises(RuntimeError, match='Cannot stop'): asyncio.run(log.flush())
    w.storage.add_batch = original; w.stop()


def migrate_index(engine):
    from sqlalchemy import Column, Index, MetaData, String, Table
    from watchfn import get_log_index_schema
    schema = get_log_index_schema()
    metadata = MetaData()
    table = Table(schema.name, metadata, *[Column(f.name, String, primary_key=f.primary_key, nullable=f.nullable, unique=f.unique) for f in schema.fields])
    for index in schema.indexes:
        Index(index.name, *[table.c[name] for name in index.fields], unique=index.unique)
    metadata.create_all(engine)
    return table


def test_sqlite_actual_index_seek_legacy_policy_backfill_reopen_and_plan(tmp_path):
    from sqlalchemy import create_engine, select, text
    from superfunctions_sqlalchemy import create_adapter
    from watchfn import Event
    from test_database import migrate
    engine = create_engine('sqlite:///' + str(tmp_path / 'logs.sqlite'))
    events = migrate(engine); indexes = migrate_index(engine)
    w = watch(storage='database', database=create_adapter(engine)); log = logger()
    detach = w.use(log); w.start()
    try:
        for n in range(40): log.info('indexed', {'service': 'match' if n == 17 else 'other'})
        # Unindexed and differently configured rows must remain candidates.
        w.storage.add(Event(type='log', name='legacy', properties={'service': 'match', 'level': 'info', 'message': 'legacy'}))
        detach(); w.use(log, {'indexFields': ['level']}); log.info('new policy', {'service': 'match'})
        results = w.logs.query({'filters': {'service': 'match'}})
        assert len(results) == 3
        assert w.logs.aggregate({'filters': {'service': 'match'}, 'aggregation': 'count'})[0]['value'] == 3
        with engine.connect() as connection:
            assert len(connection.execute(select(indexes)).all()) == 81
            plans = connection.execute(text("EXPLAIN QUERY PLAN SELECT eventId FROM watchfn_log_index WHERE field='service' AND valueType='string' AND valueKey='hash' ORDER BY eventId LIMIT 100")).all()
            assert any('SEARCH' in row[-1] and 'lookup' in row[-1] for row in plans)
        # Observe actual shared adapter selection: only matching or uncovered rows
        # fetch payload, while every event metadata row is still bounded/scanned.
        adapter = w.storage.db
        original = adapter.transaction
        payload_reads = []
        async def observed(callback):
            async def inner(tx):
                old = tx.find_one
                async def read(params):
                    if params.model == 'watchfn_events' and params.select == ['payload']:
                        payload_reads.append(params)
                    return await old(params)
                tx.find_one = read
                try: return await callback(tx)
                finally: tx.find_one = old
            return await original(inner)
        adapter.transaction = observed
        assert len(w.logs.query({'filters': {'service': 'match'}})) == 3
        assert len(payload_reads) == 3
        adapter.transaction = original
        w._log_integrations.stop()  # No producer remains attached during explicit backfill.
        after = None
        while True:
            page = w.storage.backfill_log_index(['service'], after=after, limit=7)
            after = page['nextCursor']
            if after is None: break
        assert len(w.logs.query({'filters': {'service': 'match'}})) == 3
        # Idempotent bounded replay produces no duplicate secondary rows.
        w.storage.backfill_log_index(['service'], limit=100)
        with engine.connect() as connection:
            assert len(connection.execute(select(indexes)).all()) == 42
    finally: w.stop(); engine.dispose()
    engine = create_engine('sqlite:///' + str(tmp_path / 'logs.sqlite'))
    w = watch(storage='database', database=create_adapter(engine)); w.start()
    try:
        assert len(w.logs.query({'filters': {'service': 'match'}})) == 3
    finally: w.stop(); engine.dispose()


def test_sqlite_index_failure_rolls_back_event_and_retry(tmp_path):
    from sqlalchemy import create_engine, select
    from superfunctions_sqlalchemy import create_adapter
    from test_database import migrate
    engine = create_engine('sqlite:///' + str(tmp_path / 'rollback.sqlite'))
    events = migrate(engine); indexes = migrate_index(engine)
    adapter = create_adapter(engine)
    w, log = watch(storage='database', database=adapter), logger()
    w.use(log); w.start()
    original = adapter.transaction
    async def fail(callback):
        async def inner(tx):
            create = tx.create
            async def broken(params):
                if params.model == 'watchfn_log_index': raise RuntimeError('index unavailable')
                return await create(params)
            tx.create = broken
            try: return await callback(tx)
            finally: tx.create = create
        return await original(inner)
    adapter.transaction = fail
    try:
        log.info('retry retained')
        with pytest.raises(RuntimeError, match='index unavailable'): asyncio.run(log.flush())
        with engine.connect() as connection:
            assert connection.execute(select(events)).all() == []
            assert connection.execute(select(indexes)).all() == []
        adapter.transaction = original
        w.flush()
        assert len(w.logs.query({'level': 'info'})) == 1
    finally: adapter.transaction = original; w.stop(); engine.dispose()


def test_scalar_index_keys_and_memory_coverage():
    from watchfn.storage.log_index import scalar_key
    assert scalar_key(0) == scalar_key(-0.0)
    assert scalar_key(1) == scalar_key(1.0)
    assert scalar_key(True) != scalar_key(1)
    assert scalar_key('1') != scalar_key(1)
    assert scalar_key(None) != scalar_key('null')
    assert scalar_key(float('nan')) is None
    assert scalar_key(2 ** 53 + 1) == scalar_key(float(2 ** 53 + 1))
    w, log = watch(), logger(); w.use(log, {'indexFields': ['value']}); w.start()
    try:
        for value in [0, False, None, '0', {'nested': 0}]: log.info('value', {'value': value})
        assert len(w.logs.query({'filters': {'value': 0}})) == 1
        assert len(w.logs.query({'filters': {'value': False}})) == 1
        assert len(w.logs.query({'filters': {'value': None}})) == 1
    finally: w.stop()


def test_invalid_config_batch_atomic_validation_and_index_metadata_not_payload():
    for options in [{'minLevel': 'notice'}, {'indexFields': ['constructor']}, {'enabled': 'yes'}, {'indexFields': ['a-b']}]:
        with pytest.raises(ValueError): watch(integrations={'logfn': options})
    class Producer:
        sink = None
        def add_sink(self, sink):
            self.sink = sink
            return lambda: None
    producer = Producer(); w = watch(); w.use(producer); w.start()
    try:
        good = {'name': 'producer', 'level': 'info', 'ts': '2026-10-25T06:00:00Z', 'msg': 'ok', 'ctx': {'logIndexFields': ['secret']}}
        with pytest.raises(ValueError): producer.sink([good, {**good, 'ts': 'not-time'}])
        assert w.logs.query({}) == []
        producer.sink([good])
        assert w.storage.events[0]._log_index_fields == ('level', 'service', 'traceId', 'userId')
        with pytest.raises(ValueError): w.use(producer, [])
    finally: w.stop()


def test_old_schema_requires_explicit_migration_and_new_index_metadata_cap(tmp_path):
    import json
    from sqlalchemy import create_engine, text
    from superfunctions_sqlalchemy import create_adapter
    from test_database import migrate
    engine = create_engine('sqlite:///' + str(tmp_path / 'old.sqlite'))
    with engine.begin() as connection:
        connection.execute(text('CREATE TABLE watchfn_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, projectionVersion BIGINT, receivedAt BIGINT, eventTimestamp BIGINT, eventType TEXT,eventApp TEXT,eventSeverity TEXT,eventIssueId TEXT,eventSessionId TEXT,eventReplayId TEXT)'))
        connection.execute(text('ALTER TABLE watchfn_events ADD COLUMN logIndexFields TEXT NULL'))
    migrate_index(engine)
    w = watch(storage='database', database=create_adapter(engine)); w.start()
    payload = json.dumps({'type':'log','name':'old','timestamp':'2026-10-25T06:00:00Z','properties':{'level':'info','message':'old','service':'a'},'context':{}})
    try:
        with engine.begin() as connection:
            connection.execute(text('INSERT INTO watchfn_events(id,payload,logIndexFields) VALUES(:id,:payload,:policy)'),
                               [{'id':f'legacy-{n:05d}', 'payload':payload, 'policy':'["service"]'} for n in range(10001)])
        # Covered metadata without matching rows cannot bypass the physical cap.
        with pytest.raises(ValueError, match='scan limit'):
            w.logs.query({'filters': {'service': 'absent'}})
    finally: w.stop(); engine.dispose()


def test_backfill_rollback_preserves_prior_coverage(tmp_path):
    from sqlalchemy import create_engine, select
    from superfunctions_sqlalchemy import create_adapter
    from test_database import migrate
    engine = create_engine('sqlite:///' + str(tmp_path / 'backfill.sqlite'))
    events = migrate(engine); indexes = migrate_index(engine)
    adapter = create_adapter(engine)
    w, log = watch(storage='database', database=adapter), logger()
    w.use(log, {'indexFields':['level']}); w.start(); log.info('retained', {'service':'api'})
    w._log_integrations.stop()
    original = adapter.transaction
    async def fail(callback):
        async def inner(tx):
            update = tx.update
            async def broken(params): raise RuntimeError('migration interrupted')
            tx.update = broken
            try: return await callback(tx)
            finally: tx.update = update
        return await original(inner)
    try:
        with engine.connect() as connection:
            before = connection.execute(select(indexes)).all()
        adapter.transaction = fail
        with pytest.raises(RuntimeError, match='migration interrupted'):
            w.storage.backfill_log_index(['service'])
        adapter.transaction = original
        with engine.connect() as connection:
            assert connection.execute(select(indexes)).all() == before
            assert connection.execute(select(events.c.logIndexFields)).scalar_one() == '["level"]'
        w.storage.backfill_log_index(['service'])
        assert len(w.logs.query({'filters': {'service':'api'}})) == 1
    finally: adapter.transaction = original; w.stop(); engine.dispose()


def test_shared_log_index_golden_vectors():
    import json
    from pathlib import Path
    from watchfn.storage.log_index import scalar_key, get_log_index_schema
    values = json.loads((Path(__file__).parent / 'fixtures/log-index-golden.json').read_text())
    for item in values:
        assert scalar_key(item['value']) == (item['valueType'], item['valueKey']), item['name']
    with pytest.raises(ValueError): get_log_index_schema('bad;table')


def test_typescript_canonical_stored_log_envelope_and_reserved_fields(tmp_path):
    import json
    from sqlalchemy import create_engine, Column, MetaData, Table, Text, String, BigInteger, Float
    from superfunctions_sqlalchemy import create_adapter
    from watchfn import get_watchfn_schema
    engine = create_engine('sqlite:///' + str(tmp_path / 'typescript.sqlite'))
    schema = get_watchfn_schema()
    table = Table(schema.name, MetaData(), *[Column(field.name, Float if field.name == 'receivedAt' else Text if field.type == 'text' else BigInteger if field.type == 'bigint' else String, primary_key=field.primary_key, nullable=field.nullable) for field in schema.fields])
    table.metadata.create_all(engine); migrate_index(engine)
    value = {'type':'log','name':'ts-logger','timestamp':'2026-10-25T06:00:00Z',
             'ts':'2026-10-25T06:00:00Z','msg':'typescript','message':'typescript','level':'info',
             'service':'api','ctx':{'service':'api'},'traceId':'a'*32,'version':'0',
             'properties':{'service':'spoof','level':'fatal','message':'spoof','type':'error','timestamp':'spoof'}}
    with engine.begin() as connection:
        connection.execute(table.insert(), {'id':'ts-event','payload':json.dumps(value),'receivedAt':1729836000000.0})
    w = watch(storage='database', database=create_adapter(engine)); w.start()
    try:
        row = w.logs.query({'level':'info','filters':{'service':'api','traceId':'a'*32}})[0]
        assert row['type'] == 'log' and row['name'] == 'ts-logger'
        assert row['properties']['message'] == 'typescript'
        assert 'timestamp' not in row['properties']
        w.storage.backfill_log_index(['service','traceId'])
        assert len(w.logs.query({'filters':{'traceId':'a'*32}})) == 1
        with engine.begin() as connection:
            connection.execute(table.update().values(payload=json.dumps({**value, 'level':'bogus'})))
        with pytest.raises(ValueError, match='Unsupported stored event'):
            w.storage.backfill_log_index(['service'])
        with engine.begin() as connection:
            connection.execute(table.update().values(payload=json.dumps({**value, 'type':'error'})))
        with pytest.raises(ValueError, match='Unsupported stored event'):
            w.logs.query({})
    finally: w.stop(); engine.dispose()


def test_index_keys_reject_lone_unicode_surrogates():
    from watchfn.storage.log_index import scalar_key
    for value in ['\ud800', '\udfff', 'before\ud800after']:
        with pytest.raises(UnicodeEncodeError): scalar_key(value)


def test_storage_callback_logging_fails_explicitly_without_reentrant_deadlock():
    import subprocess
    import sys
    script = '''
import asyncio
from logfn import create_logger
from watchfn import WatchFn
w=WatchFn('reentrant')
w.system_metrics.start=lambda:None
w.process_metrics.start=lambda:None
log=create_logger(name='storage',sinks=[lambda batch:None])
w.use(log);w.start()
original=w.storage.add_batch
def storage(events):
    try:
        w.flush()
    except RuntimeError as error:
        assert 'Reentrant' in str(error)
    else:
        raise AssertionError('recursive flush must fail explicitly')
    log.info('storage callback')
    original(events)
w.storage.add_batch=storage
w.track('event')
w.flush()
try:
    asyncio.run(log.flush())
except RuntimeError as error:
    assert 'Reentrant' in str(error)
else:
    raise AssertionError('recursive log must fail explicitly')
w.stop()
assert len(w.storage.query())==1
'''
    result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=3)
    assert result.returncode == 0, result.stderr


def test_normalized_structured_expansion_rejected_before_any_batch_admission():
    import json
    class Producer:
        def add_sink(self, sink):
            self.sink = sink
            return lambda: None
    producer = Producer(); w = watch(); w.use(producer); w.start()
    try:
        good = {'name':'app','level':'info','ts':'2026-10-25T06:00:00Z','msg':'small'}
        expanded = {**good, 'msg':json.dumps({'large':'x'*35000})}
        assert len(json.dumps(expanded).encode()) < 65536
        with pytest.raises(OverflowError, match='payload limit'):
            producer.sink([good, expanded])
        assert w.logs.query({}) == []
    finally: w.stop()


def test_received_order_accepts_driver_integral_float_only():
    from watchfn.storage.database import received_order
    assert received_order(1729836000000.0) == 1729836000000
    assert received_order(None) == 0
    for value in [True, False, -1, -1.0, 1.5, float('inf'), float('nan'), 9007199254740992, '1']:
        with pytest.raises(ValueError, match='Invalid stored event order'):
            received_order(value)
