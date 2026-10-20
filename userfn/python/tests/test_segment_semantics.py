import json
from pathlib import Path
import pytest
from userfn.core.segments import SegmentEvaluator
from userfn.core.flags import FlagEvaluator
from userfn.types import Segment, SegmentRule, FlagConfig, FlagRule, FlagVariation, UserIdentity, FlagPrerequisite
VECTORS=json.loads((Path(__file__).parent/'fixtures'/'segment-semantics.json').read_text())

@pytest.mark.parametrize('vector',VECTORS,ids=lambda vector:vector['id'])
def test_shared_segment_semantics(vector):
    rule=SegmentRule(vector['id'],'subject',vector['operator'],vector['value'])
    engine=SegmentEvaluator([Segment('segment','segment',[rule])])
    assert engine.evaluate('segment',vector['traits']) is vector['expected']
    flags=FlagEvaluator([FlagConfig('target',[FlagVariation('match',True)],False,[FlagRule('inline',constraints=[rule],variation_id='match')],True)],engine)
    assert flags.get_flag('target',False,UserIdentity('person',vector['traits'])) is vector['expected']

def test_invalid_json_operands_do_not_grant_negative_comparisons():
    engine=SegmentEvaluator();cycle={};cycle['self']=cycle
    for trait in [float('nan'),float('inf'),cycle,object(),10**10000]:
        for operator in ['equals','does_not_equal','in','not_in']:
            value=[1] if operator in ['in','not_in'] else 1
            assert engine.matches_rule(SegmentRule('r','subject',operator,value),{'subject':trait}) is False


def test_native_surrogate_pair_strings_and_object_keys_follow_js_equality():
    engine=SegmentEvaluator()
    native_pair='\ud83d\ude00'
    for native, wire in [(native_pair,'😀'),({native_pair:[native_pair]}, {'😀':['😀']})]:
        assert engine.matches_rule(SegmentRule('r','subject','equals',wire),{'subject':native}) is True
        assert engine.matches_rule(SegmentRule('r','subject','in',[wire]),{'subject':native}) is True
    assert engine.matches_rule(SegmentRule('r','😀','equals','yes'),{native_pair:'yes'}) is True
    assert engine.matches_rule(SegmentRule('r',native_pair,'equals','yes'),{'😀':'yes'}) is True
    assert engine.matches_rule(SegmentRule('r','missing','does_not_exist'),{native_pair:1,'😀':2}) is False
    collision={native_pair:1,'😀':2}
    for operator in ['equals','does_not_equal','in','not_in']:
        value=[{'😀':2}] if operator in ['in','not_in'] else {'😀':2}
        assert engine.matches_rule(SegmentRule('r','subject',operator,value),{'subject':collision}) is False
    flags=FlagEvaluator([FlagConfig('target',[],True,[],True)],engine)
    with pytest.raises(TypeError,match='unique in UTF-16'):
        flags.set_flags([FlagConfig('target',[],collision,[],True)])
    assert flags.get_flag('target',False) is True
    flags.set_flags([FlagConfig('gate',[],native_pair,[],True),FlagConfig('target',[],True,[],True,prerequisites=[FlagPrerequisite('gate','😀')])])
    assert flags.get_flag('target',False) is True
