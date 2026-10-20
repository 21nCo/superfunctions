import asyncio
from dataclasses import replace
import pytest
pytest.importorskip('httpx')
from userfn import UserFnClient, UserFnOptions, ExposureOptions
from userfn.types import FlagConfig, FlagVariation, FlagRule, FlagPrerequisite, FlagEnvironmentOverride


def flag(key='target', **changes):
    return replace(FlagConfig(key, [FlagVariation('first','same'),FlagVariation('chosen','same')], 'default', [FlagRule('rule-2',variation_id='chosen')], True), **changes)


def client(**options):
    return UserFnClient(UserFnOptions('unused', exposures=ExposureOptions('https://watch.example/ingest','key','app',**options)))


def test_selected_provenance_and_only_requested_flag_exposure():
    c=client(); c.identify('person',{'secret':'never send'})
    c.set_flags([flag('dependency'),flag(prerequisites=[FlagPrerequisite('dependency','same')])])
    assert c.get_flag('target')=='same'
    import json
    event=json.loads(c.exposures.queue[0])
    assert len(c.exposures.queue)==1
    assert event['properties']=={'flagKey':'target','variationId':'chosen','ruleId':'rule-2','reason':'rule'}
    assert event['user']=={'id':'person'}
    assert 'never send' not in str(event) and 'value' not in event['properties']


def test_defaults_environment_and_unavailable_provenance():
    c=UserFnClient(UserFnOptions('unused', environment='prod',exposures=ExposureOptions('https://watch.example/ingest','key','app')))
    c.set_flags([flag(rules=[],default_variation_id='first',environment_overrides={'prod':FlagEnvironmentOverride(default_variation_id='chosen')}),flag('plain',rules=[])])
    c.get_flag('target');c.get_flag('plain');c.get_flag('missing')
    import json
    events=[json.loads(raw)['properties'] for raw in c.exposures.queue]
    assert [(e['variationId'],e['ruleId'],e['reason']) for e in events]==[('chosen',None,'default_variation'),(None,None,'default_value'),(None,None,'unavailable')]
    assert all(e['environment']=='prod' for e in events)


def test_queue_bounds_close_and_secure_configuration():
    with pytest.raises(ValueError):
        UserFnClient(UserFnOptions('unused',exposures=ExposureOptions('http://watch.example/ingest','key','app')))
    c=client(max_queue_size=1);c.set_flags([flag()]); assert c.get_flag('target')=='same';assert c.get_flag('target')=='same'
    assert c.get_exposure_status()['dropped']==1
    c.exposures.closed=True
    assert c.get_flag('target')=='same' and c.get_exposure_status()['dropped']==2
    c=client();assert c.get_flag('x'*70000,'fallback')=='fallback';assert c.get_exposure_status()['dropped']==1


def test_flush_coalesces_and_failed_attempt_preserves_exact_event(monkeypatch):
    import httpx
    bodies=[]; failure=True
    async def respond(request):
        bodies.append(request.content)
        return httpx.Response(503 if failure else 202)
    original=httpx.AsyncClient
    def create(**kwargs):
        return original(transport=httpx.MockTransport(respond),**kwargs)
    monkeypatch.setattr(httpx,'AsyncClient',create)
    async def run():
        nonlocal failure
        c=client();c.set_flags([flag()]);c.get_flag('target')
        with pytest.raises(RuntimeError,match='retained'): await c.flush_exposures()
        assert c.get_exposure_status()['pending']==1
        failure=False
        await asyncio.gather(c.flush_exposures(),c.flush_exposures())
        assert len(bodies)==2 and bodies[0]==bodies[1]
        await c.close_exposures();assert c.get_exposure_status()['closed']
    asyncio.run(run())


def test_bootstrap_provenance_and_flush_reports_dropped_events(monkeypatch):
    import json
    c=UserFnClient(UserFnOptions('unused',bootstrap_flags={'boot':0},exposures=ExposureOptions('https://watch.example/ingest','key','app')))
    assert c.get_flag('boot')==0
    assert json.loads(c.exposures.queue[0])['properties']['reason']=='bootstrap'
    c.set_flags([flag('boot',rules=[])])
    c.get_flag('boot')
    assert json.loads(c.exposures.queue[1])['properties']['reason']=='default_value'
    c.exposures.queue.clear()
    c.get_flag('x'*70000)
    async def run():
        with pytest.raises(RuntimeError,match='rejected before delivery'):
            await c.flush_exposures()
        await c.flush_exposures()
    asyncio.run(run())
