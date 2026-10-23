from concurrent.futures import ThreadPoolExecutor
import json

import pytest
from sqlalchemy import select
from watchfn import WatchFn
from test_database import migrate
from test_durable_alerts import migrate_alerts, open_watch, definition
from test_alert_dispatch import endpoint


@pytest.fixture
def database(tmp_path, endpoint):
    url, state = endpoint
    state.update(status=202, pagerduty=True)
    path = 'sqlite:///' + str(tmp_path / 'pagerduty.sqlite')
    config = {'pagerDutyEndpoint': url}
    engine, watch = open_watch(path, alerts=config)
    migrate(engine); tables = migrate_alerts(engine)
    try: yield path, engine, watch, tables, config
    finally: watch.stop(); engine.dispose()


def rule():
    value = definition()
    value['severity'] = 'warning'
    value['channels'] = [{'type': 'pagerduty', 'integrationKey': 'test-owned-private-key', 'severity': 'critical'}]
    return value


def drain(watch):
    # Predecessor completion may occur after its successor was skipped in a page.
    for _ in range(8): watch.alerts.process_notifications()


def test_ordered_trigger_ack_resolve_across_reopen_and_two_workers(database, endpoint):
    path, engine, watch, tables, config = database
    url, state = endpoint
    identifier = watch.alerts.create(rule())['id']
    watch.alerts.trigger(identifier)
    watch.alerts.acknowledge(identifier, acknowledged_by='operator')
    watch.alerts.resolve(identifier, resolved_by='operator')
    watch.alerts.process_notifications()  # Establish namespace and first due predecessor.
    watch.stop(); engine.dispose()
    first_engine, first = open_watch(path, alerts=config)
    second_engine, second = open_watch(path, alerts=config)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(drain, [first, second]))
        bodies = [item['body'] for item in state['requests']]
        assert [item['event_action'] for item in bodies] == ['trigger', 'acknowledge', 'resolve']
        assert len({item['dedup_key'] for item in bodies}) == 1
        assert bodies[0]['payload'] == {'summary': 'slow', 'source': 'database', 'severity': 'critical', 'custom_details': {'alertId': identifier, 'description': ''}}
        assert all(item['routing_key'] == 'test-owned-private-key' for item in bodies)
        assert first.alerts.get_record(identifier)['pendingNotifications'] == 0
        assert 'private-key' not in json.dumps(first.alerts.notifications())
        with first_engine.connect() as connection:
            rows = connection.execute(select(tables['watchfn_alert_outbox'].c.payload)).scalars().all()
            assert all('test-owned-private-key' not in row for row in rows)
            assert all('pagerDuty' in json.loads(row) for row in rows)
    finally:
        first.stop(); second.stop(); first_engine.dispose(); second_engine.dispose()


def test_unknown_trigger_blocks_successors_until_explicit_delivered_reconciliation(database, endpoint):
    path, engine, watch, tables, config = database
    url, state = endpoint; state['drop'] = True
    identifier = watch.alerts.create(rule())['id']
    watch.alerts.trigger(identifier)
    watch.alerts.acknowledge(identifier, acknowledged_by='operator')
    watch.alerts.resolve(identifier, resolved_by='operator')
    drain(watch)
    assert [item['body']['event_action'] for item in state['requests']] == ['trigger']
    jobs = watch.alerts.notifications()
    trigger = next(item for item in jobs if item['event'] == 'triggered')
    assert trigger['outcome'] == 'unknown'
    assert sorted(item['attempts'] for item in jobs) == [0, 0, 1]
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 3
    state['drop'] = False
    second_engine, second = open_watch(path, alerts=config)
    try:
        drain(second)
        assert len(state['requests']) == 1
        second.alerts.reconcile_notification(trigger['id'], outcome='delivered', actor='operator', reason='PagerDuty accepted event independently verified')
        drain(second)
        assert [item['body']['event_action'] for item in state['requests']] == ['trigger', 'acknowledge', 'resolve']
        assert second.alerts.get_record(identifier)['pendingNotifications'] == 0
    finally: second.stop(); second_engine.dispose()


def test_new_episode_waits_for_previous_resolution_and_has_new_dedup_key(database, endpoint):
    path, engine, watch, tables, config = database
    url, state = endpoint
    identifier = watch.alerts.create(rule())['id']
    watch.alerts.trigger(identifier); watch.alerts.resolve(identifier, resolved_by='operator')
    watch.alerts.trigger(identifier); watch.alerts.resolve(identifier, resolved_by='operator')
    drain(watch)
    bodies = [item['body'] for item in state['requests']]
    assert [item['event_action'] for item in bodies] == ['trigger', 'resolve', 'trigger', 'resolve']
    assert bodies[0]['dedup_key'] == bodies[1]['dedup_key']
    assert bodies[2]['dedup_key'] == bodies[3]['dedup_key']
    assert bodies[0]['dedup_key'] != bodies[2]['dedup_key']


def test_routing_changes_require_resolved_delivery_not_only_local_resolution(database, endpoint):
    path, engine, watch, tables, config = database
    identifier = watch.alerts.create(rule())['id']; watch.alerts.trigger(identifier)
    changed = rule(); changed['channels'][0]['integrationKey'] = 'another-key'
    with pytest.raises(ValueError, match='routing keys'): watch.alerts.update(identifier, changed)
    watch.alerts.resolve(identifier, resolved_by='operator')
    with pytest.raises(ValueError, match='routing keys'): watch.alerts.update(identifier, changed)
    drain(watch)
    watch.alerts.update(identifier, changed)
    assert watch.alerts.get_record(identifier)['channels'] == [{'type': 'pagerduty', 'configured': True}]


@pytest.mark.parametrize('body', [b'{"status":"success","dedup_key":"wrong"}', b'private-provider-error', b'X' * 4097])
def test_invalid_receipt_is_unknown_without_error_body_or_retry(database, endpoint, body):
    path, engine, watch, tables, config = database
    url, state = endpoint; state.update(pagerduty=False, body=body)
    identifier = watch.alerts.create(rule())['id']; watch.alerts.trigger(identifier)
    drain(watch)
    jobs = watch.alerts.notifications()
    assert jobs[0]['outcome'] == 'unknown' and jobs[0]['attempts'] == 1
    assert len(state['requests']) == 1 and 'private' not in json.dumps(jobs)
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 1


@pytest.mark.parametrize('metadata', [None, {}, {'episode': '', 'route': 'invalid'}, {'episode': 42, 'route': 'invalid'}])
def test_legacy_job_without_episode_fails_before_claim_or_http(database, endpoint, metadata):
    path, engine, watch, tables, config = database
    identifier = watch.alerts.create(rule())['id']; watch.alerts.trigger(identifier)
    table = tables['watchfn_alert_outbox']
    with engine.begin() as connection:
        raw = json.loads(connection.execute(select(table.c.payload)).scalar_one()); raw.pop('pagerDuty')
        if metadata is not None: raw['pagerDuty'] = metadata
        connection.execute(table.update().values(payload=json.dumps(raw)))
    with pytest.raises(ValueError, match='incident migration|dependency metadata'): watch.alerts.process_notifications()
    assert watch.alerts.notifications()[0]['attempts'] == 0
    assert not endpoint[1]['requests']


def test_provider_configuration_rejects_invalid_severity_duplicates_and_endpoint(database):
    path, engine, watch, tables, config = database
    value = rule(); value['channels'][0]['severity'] = 'urgent'
    with pytest.raises(ValueError, match='severity'): watch.alerts.create(value)
    value = rule(); value['channels'] *= 2
    with pytest.raises(ValueError, match='Duplicate'): watch.alerts.create(value)
    for url in ['file:///tmp/not-http', 'https://user:password@example.invalid/api', 'https://example.invalid:bad/api']:
        with pytest.raises(ValueError, match='endpoint'): WatchFn('validation', alerts={'pagerDutyEndpoint': url})


def test_shared_pagerduty_wire_vectors():
    from pathlib import Path
    from watchfn.alerts.pagerduty import request
    for value in json.loads((Path(__file__).parent / 'fixtures' / 'pagerduty-golden.json').read_text()):
        assert request(value['namespace'], value['notification'], value['channel'], value['metadata']) == value['expected']
