import asyncio
import json
import pytest
from userfn import ConsentOptions, ExposureOptions, UserFnClient, UserFnOptions


def client(**kwargs):
    return UserFnClient(UserFnOptions('unused', bootstrap_flags={'feature': 'value'}, exposures=ExposureOptions('https://watch.example/ingest', 'key', 'app'), **kwargs))


def test_defaults_denials_dnt_and_reset_preservation():
    c = client()
    assert c.get_consent() == {'analytics': True, 'messaging': True, 'do_not_track': False}
    assert c.get_flag('feature') == 'value'
    assert c.get_exposure_status()['pending'] == 1
    c.set_consent(analytics=False)
    assert c.get_exposure_status()['discarded'] == 1
    assert c.get_exposure_status()['pending'] == 0
    assert c.get_flag('feature') == 'value'
    assert c.get_exposure_status()['dropped'] == 0
    c.reset()
    assert c.get_consent()['analytics'] is False
    c.set_consent(analytics=True, do_not_track=True)
    assert c.get_consent() == {'analytics': False, 'messaging': False, 'do_not_track': True}
    c.get_flag('feature')
    assert c.get_exposure_status()['pending'] == 0
    c.set_consent(do_not_track=False)
    c.get_flag('feature')
    assert c.get_exposure_status()['pending'] == 1
    assert c.get_exposure_status()['discarded'] == 1


def test_invalid_patch_is_atomic_and_constructor_validates():
    c = client()
    with pytest.raises(ValueError):
        c.set_consent(analytics=False, messaging='yes')
    assert c.get_consent()['analytics'] is True
    for value in (0, 1, 'false', [], {}):
        with pytest.raises(ValueError):
            client(consent=ConsentOptions(analytics=value))
        with pytest.raises(ValueError):
            client(do_not_track=value)
    c = client(consent=ConsentOptions(analytics=False, messaging=False))
    assert c.get_flag('feature') == 'value'
    assert c.trigger('event', 'hello') == []
    assert c.get_exposure_status()['pending'] == 0


def test_denied_trigger_never_consumes_messaging_eligibility(monkeypatch):
    c = client(consent=ConsentOptions(messaging=False))
    called = []
    monkeypatch.setattr(c.messaging, 'get_eligible_messages', lambda *args: called.append(args) or ['campaign'])
    assert c.trigger('event', 'hello') == []
    c.set_consent(messaging=True)
    assert c.trigger('event', 'hello') == ['campaign']
    assert len(called) == 1


def test_owned_discard_fences_abort_ignoring_old_delivery_and_immediate_regrant(monkeypatch):
    import httpx
    async def scenario():
        c = client()
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []
        class Response:
            status_code = 202
            async def __aenter__(self):
                if len(calls) == 1:
                    entered.set()
                    try:
                        await release.wait()
                    except asyncio.CancelledError:
                        await release.wait()  # Simulate a provider ignoring cancellation.
                return self
            async def __aexit__(self, *args):
                return False
        class Http:
            def __init__(self, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return False
            def stream(self, method, endpoint, **kwargs):
                calls.append(json.loads(kwargs['content']))
                return Response()
        monkeypatch.setattr(httpx, 'AsyncClient', Http)
        c.get_flag('old')
        old = asyncio.create_task(c.flush_exposures())
        await entered.wait()
        c.set_consent(analytics=False)
        assert c.get_exposure_status()['pending'] == 0
        c.set_consent(analytics=True)
        c.get_flag('new')
        await c.flush_exposures()
        with pytest.raises(RuntimeError, match='discarded'):
            await asyncio.wait_for(old, timeout=.2)
        release.set()
        await asyncio.sleep(0)
        assert [[e['properties']['flagKey'] for e in batch] for batch in calls] == [['old'], ['new']]
        assert c.get_exposure_status()['discarded'] == 1
        assert c.get_exposure_status()['pending'] == 0
        assert c.get_exposure_status()['lastError'] is None
    asyncio.run(scenario())


@pytest.mark.parametrize('phase', ['enter', 'exit'])
def test_cancel_ignoring_context_boundaries_cannot_report_withdrawn_flush_success(monkeypatch, phase):
    import httpx
    async def scenario():
        c = client()
        entered, release = asyncio.Event(), asyncio.Event()
        class Http:
            def __init__(self, **kwargs): pass
            async def boundary(self):
                entered.set()
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    await release.wait()
            async def __aenter__(self):
                if phase == 'enter': await self.boundary()
                return self
            async def __aexit__(self, *args):
                if phase == 'exit': await self.boundary()
                return False
        monkeypatch.setattr(httpx, 'AsyncClient', Http)
        old = asyncio.create_task(c.flush_exposures())
        await entered.wait()
        c.set_consent(analytics=False)
        with pytest.raises(RuntimeError, match='discarded'):
            await asyncio.wait_for(old, timeout=.2)
        release.set()
        await asyncio.sleep(0)
        assert c.get_exposure_status()['lastError'] is None
    asyncio.run(scenario())
