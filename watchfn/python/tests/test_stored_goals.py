import json
import pytest
from test_stored_funnels import open_watch
from watchfn.storage.events import decode_event
from watchfn.business.goals import goal_period,goal_date,validate_goal


def config(**extra):return dict(name='sales',target=100,metric='purchase.completed.total',aggregation='sum',period='month',startDate='2026-01-31',**extra)


def test_goal_utc_anchor_stored_events_and_restart():
    w=open_watch('goals')
    try:
        w.business.create_goal(config())
        for date,value in [('2026-02-01',25),('2026-02-02',-5)]:w.storage.add(decode_event(json.dumps(dict(type='track',name='purchase.completed',app={'name':'goals'},timestamp=date+'T00:00:00Z',properties={'total':value}))))
        p=w.business.get_goal_progress(dict(name='sales',date='2026-02-14'))
        assert (p['actual'],p['eventCount'],p['elapsedPercent'],p['expected'])==(20,2,50,50)
        assert p['periodEnd']==goal_date('2026-02-28')
        assert w.business.get_goal_progress(dict(name='sales',date='2026-02-28'))['periodEnd']==goal_date('2026-03-31')
        with pytest.raises(Exception):w.business.create_goal(config())
        w.stop();w.start();assert w.business.get_goal_progress(dict(name='sales',date='2026-02-14'))['actual']==20
    finally:w.stop()


def test_goal_unknown_channels_date_validation_and_empty_average():
    w=open_watch('goals')
    try:
        with pytest.raises(ValueError):w.business.create_goal(config(alerts=dict(on_track_check='50%',notify_below_pace=True,channels=['missing'])))
        options=config();options['aggregation']='avg';w.business.create_goal(options)
        assert w.business.get_goal_progress(dict(name='sales',date='2026-02-14'))['actual'] is None
        with pytest.raises(ValueError):goal_date('2026-02-30')
        leap=config();leap.update(period='year',startDate='2024-02-29')
        assert goal_period(validate_goal(leap),goal_date('2025-02-28'))==(goal_date('2025-02-28'),goal_date('2026-02-28'))
    finally:w.stop()

from test_alert_dispatch import endpoint  # noqa: F401
from watchfn import WatchFn
from watchfn.business.goals import goal_id


def test_goal_real_webhook_period_rollover_and_recovery_after_commit(endpoint):
    url,state=endpoint
    w=WatchFn('goals',alerts={'namedChannels':{'ops':{'type':'webhook','webhook':url}}})
    w.system_metrics.start=lambda:None;w.process_metrics.start=lambda:None;w.start()
    try:
        w.business.create_goal(config(alerts=dict(on_track_check='50%',notify_below_pace=True,channels=['ops'])))
        w.alerts.evaluate_stored(now=goal_date('2026-02-14'))
        fail=[True]
        def failed_resolution(*args):
            if fail[0]:fail[0]=False;raise RuntimeError('owned post-commit failure')
        w.alerts.on_resolve(failed_resolution)
        with pytest.raises(RuntimeError):w.alerts.evaluate_stored(now=goal_date('2026-03-16'))
        assert w.alerts.get_record(goal_id('goals','sales','goal-alert'))['resolvedBy']=='goal-period-ended'
        w.alerts.evaluate_stored(now=goal_date('2026-03-16'))
        w.alerts.process_notifications()
        assert len(state['requests'])==3
        w.alerts.evaluate_stored(now=goal_date('2026-03-16'));w.alerts.process_notifications();assert len(state['requests'])==3
        with pytest.raises(Exception):w.alerts.evaluate_stored(now=goal_date('2026-02-14'))
    finally:w.stop()


def test_goal_native_reopen_atomic_rollback_and_foreign_events(tmp_path):
    from sqlalchemy import create_engine
    from superfunctions_sqlalchemy import create_adapter
    from test_database import migrate
    from test_durable_alerts import migrate_alerts
    from test_stored_funnels import migrate_business
    engine=create_engine('sqlite:///'+str(tmp_path/'goals.sqlite'));migrate(engine);migrate_alerts(engine);migrate_business(engine)
    w=open_watch('goals',create_adapter(engine))
    try:
        w.business.create_goal(config())
        w.storage.add(decode_event(json.dumps(dict(type='track',name='purchase.completed',app={'name':'other'},timestamp='2026-02-01T00:00:00Z',properties={'total':99}))))
    finally:w.stop();engine.dispose()
    engine=create_engine('sqlite:///'+str(tmp_path/'goals.sqlite'));w=open_watch('goals',create_adapter(engine))
    try:assert w.business.get_goal_progress(dict(name='sales',date='2026-02-14'))['actual']==0
    finally:w.stop();engine.dispose()


def test_goal_rollover_rejects_intervening_disable(endpoint):
    url,_=endpoint
    w=WatchFn('goals',alerts={'namedChannels':{'ops':{'type':'webhook','webhook':url}}})
    w.system_metrics.start=lambda:None;w.process_metrics.start=lambda:None;w.start()
    try:
        w.business.create_goal(config(alerts=dict(on_track_check='50%',notify_below_pace=True,channels=['ops'])))
        w.alerts.evaluate_stored(now=goal_date('2026-02-14'))
        identifier=goal_id('goals','sales','goal-alert')
        w.alerts.on_resolve(lambda *_:w.alerts.disable(identifier))
        with pytest.raises(Exception,match='changed during goal period rollover'):w.alerts.evaluate_stored(now=goal_date('2026-03-16'))
        assert w.alerts.get_record(identifier)['enabled'] is False
        assert len(w.alerts.notifications())==2
    finally:w.stop()


def test_goal_second_insert_failure_rolls_back(tmp_path,monkeypatch):
    from sqlalchemy import create_engine,text
    from superfunctions_sqlalchemy import create_adapter
    from superfunctions_sqlalchemy.adapter import SQLAlchemyTransactionAdapter
    from test_database import migrate
    from test_durable_alerts import migrate_alerts
    from test_stored_funnels import migrate_business
    engine=create_engine('sqlite:///'+str(tmp_path/'rollback.sqlite'));migrate(engine);migrate_alerts(engine);migrate_business(engine)
    w=WatchFn('goals',storage='database',database=create_adapter(engine),alerts={'namedChannels':{'ops':{'type':'webhook','webhook':'http://127.0.0.1:1'}}})
    w.system_metrics.start=lambda:None;w.process_metrics.start=lambda:None;w.start()
    original=SQLAlchemyTransactionAdapter.create
    async def fail(self,params):
        if params.model=='watchfn_alerts':raise RuntimeError('owned second insert failure')
        return await original(self,params)
    try:
        with monkeypatch.context() as patch:
            patch.setattr(SQLAlchemyTransactionAdapter,'create',fail)
            with pytest.raises(Exception):w.business.create_goal(config(alerts=dict(on_track_check='50%',notify_below_pace=True,channels=['ops'])))
        with engine.connect() as connection:
            assert connection.execute(text('SELECT COUNT(*) FROM watchfn_business_definitions')).scalar()==0
            assert connection.execute(text('SELECT COUNT(*) FROM watchfn_alerts')).scalar()==0
        w.business.create_goal(config(alerts=dict(on_track_check='50%',notify_below_pace=True,channels=['ops'])))
        with engine.connect() as connection:assert connection.execute(text('SELECT COUNT(*) FROM watchfn_alert_runtime')).scalar()==1
    finally:w.stop();engine.dispose()


def test_goal_validation_identity_future_and_bounded_aggregation():
    from watchfn.business.goals import progress
    with pytest.raises(ValueError):goal_id('\ud800','sales')
    with pytest.raises(ValueError):validate_goal(dict(config(),metric='missingdot'))
    events=[decode_event(json.dumps(dict(type='track',name='purchase.completed',app={'name':'goals'},timestamp='2026-02-01T00:00:00Z',properties={'total':1}))) for _ in range(1001)]
    assert progress(events,'goals',config(),'2026-02-14')['actual']==1001
    with pytest.raises(ValueError):progress(events,'goals',config(),'2026-02-14',1000)
