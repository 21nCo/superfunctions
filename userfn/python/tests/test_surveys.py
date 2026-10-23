import asyncio
from dataclasses import replace

import pytest

from userfn import UserFnClient, UserFnOptions
from userfn.core.segments import SegmentEvaluator
from userfn.core.surveys import SurveyEngine
from userfn.types import (CampaignTrigger, Segment, SegmentRule, Survey,
                          SurveyCaps, SurveyReceipt, SurveyResponse, UserIdentity)


def survey(**changes):
    return replace(Survey(id='s', questions=[], enabled=True,
                          triggers=[CampaignTrigger(type='event', pattern='paid')]), **changes)


def test_local_caps_follow_identity_and_survive_configuration_refresh():
    engine = SurveyEngine(SegmentEvaluator())
    engine.set_surveys([survey()])
    alice, bob = UserIdentity('alice', {}), UserIdentity('bob', {})
    assert len(engine.get_eligible_surveys('event', 'invoice-paid', alice)) == 1
    engine.track_response(SurveyResponse('s', [], 123), alice)
    engine.set_surveys([survey()])
    assert engine.get_eligible_surveys('event', 'invoice-paid', alice) == []
    assert len(engine.get_eligible_surveys('event', 'invoice-paid', bob)) == 1
    assert engine.get_eligible_surveys('event', 'invoice-paid', None) == []


@pytest.mark.parametrize('cap', [0, -1, .5, float('nan'), float('inf'), '1', True, 2**53])
def test_invalid_or_zero_caps_deny(cap):
    engine = SurveyEngine(SegmentEvaluator())
    engine.set_surveys([survey(caps=SurveyCaps(cap))])
    assert engine.get_eligible_surveys('event', 'paid', UserIdentity('u', {})) == []


@pytest.mark.parametrize('cap', [None, 1, 1.0])
def test_default_and_integral_cap(cap):
    engine = SurveyEngine(SegmentEvaluator())
    engine.set_surveys([survey(caps=SurveyCaps(cap))])
    user = UserIdentity('u', {})
    assert len(engine.get_eligible_surveys('event', 'paid', user)) == 1
    engine.track_response(SurveyResponse('s', [], 123), user)
    assert engine.get_eligible_surveys('event', 'paid', user) == []


def test_trigger_segment_and_disabled_gates():
    segments = SegmentEvaluator([Segment('pro', 'Pro', [SegmentRule('r', 'plan', 'equals', 'pro')])])
    engine = SurveyEngine(segments)
    engine.set_surveys([survey(segment_id='pro'), survey(id='off', enabled=False)])
    assert engine.get_eligible_surveys('event', 'paid', UserIdentity('u', {'plan': 'free'})) == []
    assert len(engine.get_eligible_surveys('event', 'paid', UserIdentity('u', {'plan': 'pro'}))) == 1
    assert engine.get_eligible_surveys('url_match', 'paid', UserIdentity('u', {'plan': 'pro'})) == []
    segments.set_segments([])
    assert engine.get_eligible_surveys('event', 'paid', UserIdentity('u', {'plan': 'pro'})) == []


def test_utf16_substring_matches_typescript_surrogate_semantics():
    engine = SurveyEngine(SegmentEvaluator())
    engine.set_surveys([survey(triggers=[CampaignTrigger(type='event', pattern='\ud83d')])])
    assert len(engine.get_eligible_surveys('event', '\U0001f600', UserIdentity('u', {}))) == 1


def test_public_client_respects_identity_consent_and_dnt_without_network():
    client = UserFnClient(UserFnOptions(api_key='local'))
    client.set_surveys([survey()])
    assert client.get_eligible_surveys('event', 'paid') == []

    client.identify('alice')
    assert len(client.get_eligible_surveys('event', 'paid')) == 1
    client.set_consent(messaging=False)
    assert client.get_eligible_surveys('event', 'paid') == []
    client.set_consent(messaging=True, do_not_track=True)
    assert client.get_eligible_surveys('event', 'paid') == []
    client.set_consent(do_not_track=False)
    assert len(client.get_eligible_surveys('event', 'paid')) == 1
    client.reset()
    assert client.get_eligible_surveys('event', 'paid') == []


def test_acknowledgement_counts_once_for_original_identity_and_failure_does_not():
    async def run():
        client = UserFnClient(UserFnOptions(api_key='local'))
        client.set_surveys([survey(caps=SurveyCaps(2))])
        client.identify('alice')

        class Service:
            fail = True

            async def submit(self, *args):
                if self.fail:
                    raise RuntimeError('unknown outcome')
                client.identify('bob')
                return SurveyReceipt(id='receipt', survey_id='s', submitted_at=123, accepted=True)

        service = Service()
        client.survey_service = service
        with pytest.raises(RuntimeError):
            await client.submit_survey_response('s', [], idempotency_key='key')
        assert client.surveys.responses == {}
        service.fail = False
        await client.submit_survey_response('s', [], idempotency_key='key')
        assert client.surveys.responses == {'alice': {'s': 1}}
        client.identify('alice')
        await client.submit_survey_response('s', [], idempotency_key='key')
        assert client.surveys.responses == {'alice': {'s': 1}}
        assert len(client.get_eligible_surveys('event', 'paid')) == 1

    asyncio.run(run())
