import json
from pathlib import Path
from dataclasses import replace
import pytest
from userfn import UserFnClient
from userfn.core.flags import FlagEvaluator
from userfn.core.segments import SegmentEvaluator
from userfn.types import (FlagConfig, FlagRule, FlagVariation, FlagPrerequisite, FlagEnvironmentOverride,
                          UserFnOptions, Segment, SegmentRule)

def flag(key, **changes):
    return replace(FlagConfig(key=key, enabled=True, default_value=True, variations=[], rules=[]), **changes)

def evaluator(flags, environment=None):
    return FlagEvaluator(flags, SegmentEvaluator(), environment)

@pytest.mark.parametrize('value,expected,matches', [
    (False, False, True), (0, 0, True), ('', '', True), (True, 1, False), (0, False, False),
    ('1', 1, False), (9007199254740991, 9007199254740992, False), (9007199254740992, 9007199254740993, True), ([1, False], [1, False], True), ([1, 2], [2, 1], False),
    ({'b': [False, 0], 'a': 'x'}, {'a': 'x', 'b': [False, 0]}, True), (1, 1.0, True),
])
def test_json_prerequisites_preserve_types_and_structure(value, expected, matches):
    engine = evaluator([flag('dependency', default_value=value), flag('target', prerequisites=[FlagPrerequisite('dependency', expected)])])
    assert engine.get_flag('target', 'unavailable') == (True if matches else 'unavailable')

def test_missing_disabled_unmet_and_cyclic_dependencies_fail_closed():
    cases = [
        [flag('target', prerequisites=[FlagPrerequisite('missing', False)])],
        [flag('off', enabled=False, default_value=False), flag('target', prerequisites=[FlagPrerequisite('off', False)])],
        [flag('target', prerequisites=[FlagPrerequisite('target', True)])],
        [flag('target', prerequisites=[FlagPrerequisite('other', False)]), flag('other', default_value=False, prerequisites=[FlagPrerequisite('target', True)])],
        [flag('one'), flag('two', default_value=False), flag('target', prerequisites=[FlagPrerequisite('one', True), FlagPrerequisite('two', True)])],
    ]
    for flags in cases:
        assert evaluator(flags).get_flag('target', 'unavailable') == 'unavailable'

def test_long_chains_are_iterative_and_independent_of_insertion_order():
    flags = [flag(str(i), prerequisites=[] if i == 4999 else [FlagPrerequisite(str(i + 1), True)]) for i in range(5000)]
    assert evaluator(list(reversed(flags))).get_flag('0', False) is True

def test_dependencies_use_current_user_without_cross_identity_results():
    client = UserFnClient(UserFnOptions(api_key='unused'))
    client.set_segments([Segment(id='paid', name='Paid', rules=[SegmentRule(id='plan', field='plan', operator='equals', value='pro')])])
    client.set_flags([flag('gate', default_value=False, variations=[FlagVariation('on', True)], rules=[FlagRule('paid', segment_id='paid', variation_id='on')]), flag('target', prerequisites=[FlagPrerequisite('gate', True)])])
    assert client.get_flag('target', False) is False
    client.identify('user-a', {'plan': 'pro'}); assert client.get_flag('target', False) is True
    client.identify('user-b', {'plan': 'free'}); assert client.get_flag('target', False) is False
    client.reset(); assert client.get_flag('target', False) is False

def test_environment_applies_across_dependencies_and_global_kill_cannot_be_overridden():
    flags = [flag('gate', default_value=False, environment_overrides={'production': FlagEnvironmentOverride(default_value=True)}),
             flag('target', default_value='base', prerequisites=[FlagPrerequisite('gate', True)], environment_overrides={'production': FlagEnvironmentOverride(default_value='production'), 'disabled': FlagEnvironmentOverride(enabled=False)})]
    client = UserFnClient(UserFnOptions(api_key='unused', environment='production')); client.set_flags(flags)
    assert client.get_flag('target', 'fallback') == 'production'
    for environment in (None, 'Production', 'disabled'):
        assert evaluator(flags, environment).get_flag('target', 'fallback') == 'fallback'
    flags[1].enabled = False; flags[1].environment_overrides['production'].enabled = True
    assert evaluator(flags, 'production').get_flag('target', 'fallback') == 'fallback'
    assert client.get_flag('target', 'fallback') == 'production'

def test_environment_rules_replace_and_none_explicitly_clears_default_variation():
    definition = flag('target', default_value='base', default_variation_id='variant', variations=[FlagVariation('variant', 'variation')], rules=[FlagRule('base', variation_id='variant')], environment_overrides={
        'inherit': FlagEnvironmentOverride(), 'empty': FlagEnvironmentOverride(rules=[]),
        'cleared': FlagEnvironmentOverride(rules=[], default_variation_id=None, default_value=''),
        'zero': FlagEnvironmentOverride(rules=[], default_variation_id=None, default_value=0),
        'off': FlagEnvironmentOverride(enabled=False),
    })
    assert evaluator([definition], 'inherit').get_flag('target', False) == 'variation'
    assert evaluator([definition], 'empty').get_flag('target', False) == 'variation'
    assert evaluator([definition], 'cleared').get_flag('target', False) == ''
    assert evaluator([definition], 'zero').get_flag('target', False) == 0
    assert evaluator([definition], 'off').get_flag('target', 'fallback') == 'fallback'

def test_prototype_like_environment_names_are_literal():
    definition = flag('target', default_value='base', environment_overrides={'__proto__': FlagEnvironmentOverride(default_value='literal')})
    assert evaluator([definition], '__proto__').get_flag('target', False) == 'literal'
    assert evaluator([definition], 'toString').get_flag('target', False) == 'base'

def test_invalid_replacements_are_explicit_and_atomic():
    engine = evaluator([flag('stable')]); cyclic = {}; cyclic['self'] = cyclic
    invalid = [
        [flag('bad', default_value=float('nan'))], [flag('bad', default_value=10 ** 1000)], [flag('bad', prerequisites=[FlagPrerequisite('x', float('inf'))])],
        [flag('bad', prerequisites=[{'key': 'x'}])], [flag('bad', prerequisites=[FlagPrerequisite('x', cyclic)])],
        [flag('bad', default_value=object())], [flag('duplicate'), flag('duplicate')],
        [flag('bad', environment_overrides={'production': {'enabled': False}})],
        [flag('bad', rules=[FlagRule('bad', rollout_percentage=-1)])], [flag('bad', rules=[FlagRule('huge', rollout_percentage=10 ** 1000)])], [flag('bad', default_variation_id='missing')],
    ]
    for replacement in invalid:
        with pytest.raises(TypeError): engine.set_flags(replacement)
        assert engine.get_flag('stable', False) is True
    with pytest.raises(TypeError): evaluator([], '')
    engine.set_flags([]); assert engine.get_flag('stable', False) is False

ROLLOUT_VECTORS = json.loads((Path(__file__).parent / 'fixtures' / 'hash-vectors.json').read_text())

@pytest.mark.parametrize('vector', ROLLOUT_VECTORS)
def test_environment_rollout_prerequisites_match_shared_vectors(vector):
    client = UserFnClient(UserFnOptions(api_key='unused', environment='production'))
    client.set_flags([
        flag(vector['key'], default_value=False, variations=[FlagVariation('on', True)], rules=[FlagRule('base', rollout_percentage=100, variation_id='on')],
             environment_overrides={'production': FlagEnvironmentOverride(rules=[FlagRule('production', rollout_percentage=25, variation_id='on')])}),
        flag('dependent', default_value='enabled', prerequisites=[FlagPrerequisite(vector['key'], True)]),
    ])
    client.identify(vector['userId'])
    assert client.get_flag('dependent', 'disabled') == ('enabled' if vector['bucket'] < 25 else 'disabled')

def test_returned_structured_values_cannot_mutate_future_prerequisite_decisions():
    engine = evaluator([flag('gate', default_value={'ready': False}), flag('target', prerequisites=[FlagPrerequisite('gate', {'ready': False})])])
    returned = engine.get_flag('gate', False); returned['ready'] = True
    assert engine.get_flag('target', False) is True
    assert engine.get_flag('gate', False) == {'ready': False}
