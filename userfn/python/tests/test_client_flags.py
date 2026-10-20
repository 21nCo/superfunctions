from userfn import UserFnClient
from userfn.types import UserFnOptions, FlagConfig, FlagRule, FlagVariation, Segment, SegmentRule


def test_bootstrap_preserves_falsy_structured_values_and_client_isolation():
    values = {'off': False, 'zero': 0, 'empty': '', 'layout': {'color': 'blue'}, 'items': [1, 2],
              '__proto__': 'literal'}
    client = UserFnClient(UserFnOptions(api_key='unused', bootstrap_flags=values))
    for key, value in values.items():
        assert client.get_flag(key, 'fallback') == value
    assert client.get_flag('unknown', 'fallback') == 'fallback'
    client.identify('new-user')
    client.reset()
    assert client.get_flag('off', True) is False
    assert UserFnClient(UserFnOptions(api_key='unused')).get_flag('off', True) is True


def test_replacement_rules_and_segments_through_public_client():
    client = UserFnClient(UserFnOptions(api_key='unused', bootstrap_flags={'stale': True, 'feature': 'bootstrap'}))
    client.set_segments([Segment(id='paid', name='Paid', rules=[
        SegmentRule(id='plan', field='plan', operator='equals', value='pro')
    ])])
    client.set_flags([FlagConfig(key='feature', enabled=True, default_value='control',
                                variations=[FlagVariation(id='on', value='treatment')],
                                rules=[FlagRule(id='paid-rule', segment_id='paid', variation_id='on')])])
    assert client.get_flag('stale', False) is False
    assert client.get_flag('feature') == 'control'
    client.identify('paid-user', {'plan': 'pro'})
    assert client.get_flag('feature') == 'treatment'
    client.reset()
    assert client.get_flag('feature') == 'control'
    client.set_flags([])
    assert client.get_flag('feature', 'removed') == 'removed'
