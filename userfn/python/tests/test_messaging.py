import pytest
from userfn.core.messaging import MessagingEngine
from userfn.core.segments import SegmentEvaluator
from userfn.types import Campaign, MessageContent, CampaignTrigger, UserIdentity

CAMPAIGNS = [
    Campaign(
        id='camp-1',
        enabled=True,
        kind='modal',
        content=MessageContent(body='Hello'),
        triggers=[CampaignTrigger(type='url_match', pattern='/dashboard')],
        priority=10
    ),
    Campaign(
        id='camp-2',
        enabled=True,
        kind='banner',
        content=MessageContent(body='Welcome'),
        triggers=[CampaignTrigger(type='event', pattern='login')],
        priority=5
    )
]

class TestMessagingEngine:
    @pytest.fixture
    def engine(self):
        segments = SegmentEvaluator()
        engine = MessagingEngine(segments)
        engine.set_campaigns(CAMPAIGNS)
        return engine

    def test_matches_url_trigger(self, engine):
        user = UserIdentity(id='u1', traits={})
        eligible = engine.get_eligible_messages('url_match', '/dashboard/settings', user)
        assert len(eligible) == 1
        assert eligible[0].id == 'camp-1'

    def test_matches_event_trigger(self, engine):
        user = UserIdentity(id='u1', traits={})
        eligible = engine.get_eligible_messages('event', 'login', user)
        assert len(eligible) == 1
        assert eligible[0].id == 'camp-2'

    def test_respects_priority(self, engine):
        # Add a high priority campaign for login
        high_prio = Campaign(
            id='camp-3',
            enabled=True,
            kind='modal',
            content=MessageContent(body='Urgent'),
            triggers=[CampaignTrigger(type='event', pattern='login')],
            priority=100
        )
        engine.set_campaigns(CAMPAIGNS + [high_prio])

        user = UserIdentity(id='u1', traits={})
        eligible = engine.get_eligible_messages('event', 'login', user)
        assert len(eligible) == 2
        assert eligible[0].id == 'camp-3' # Higher priority first

    def test_ignores_disabled_campaigns(self, engine):
        disabled = Campaign(
            id='dis',
            enabled=False,
            kind='modal',
            content=MessageContent(body='Disabled'),
            triggers=[CampaignTrigger(type='url_match', pattern='/dashboard')],
            priority=10
        )
        engine.set_campaigns([disabled])
        
        user = UserIdentity(id='u1', traits={})
        eligible = engine.get_eligible_messages('url_match', '/dashboard', user)
        assert len(eligible) == 0


@pytest.mark.parametrize('caps,expected', [
    (None, [1, 1, 1]), ('omitted', [1, 1, 1]),
    (0, [0, 0, 0]), (1, [1, 0, 0]), (2, [1, 1, 0]),
])
def test_campaign_cap_parity(caps, expected):
    from dataclasses import replace
    from userfn.types import CampaignCaps
    configured = None if caps is None else CampaignCaps() if caps == 'omitted' else CampaignCaps(global_cap=caps)
    engine = MessagingEngine(SegmentEvaluator())
    engine.set_campaigns([replace(CAMPAIGNS[1], caps=configured)])
    def eligible():
        return len(engine.get_eligible_messages('event', 'login', UserIdentity('u1', {})))
    engine.track_delivery('camp-2', 'dismissed')
    engine.track_delivery('camp-2', 'clicked')
    assert eligible() == expected[0]
    engine.track_delivery('camp-2', 'shown')
    assert eligible() == expected[1]
    engine.track_delivery('camp-2', 'shown')
    assert eligible() == expected[2]
