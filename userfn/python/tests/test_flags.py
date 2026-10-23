import pytest
from userfn.core.flags import FlagEvaluator
from userfn.core.segments import SegmentEvaluator
from userfn.types import FlagConfig, FlagRule, FlagVariation, SegmentRule, UserIdentity

MOCK_FLAGS = [
    FlagConfig(
        key='feature-A',
        default_value=False,
        enabled=True,
        rules=[
            FlagRule(
                id='rule-1',
                constraints=[
                    SegmentRule(id='c1', field='email', operator='contains', value='@test.com')
                ],
                variation_id='on'
            )
        ],
        variations=[
            FlagVariation(id='on', value=True),
            FlagVariation(id='off', value=False),
        ]
    ),
    FlagConfig(
        key='feature-rollout',
        default_value='control',
        enabled=True,
        rules=[
            FlagRule(
                id='rule-2',
                rollout_percentage=50,
                variation_id='treatment'
            )
        ],
        variations=[
            FlagVariation(id='treatment', value='treatment'),
            FlagVariation(id='control', value='control')
        ]
    )
]

class TestFlagEvaluator:
    @pytest.fixture
    def evaluator(self):
        segments = SegmentEvaluator()
        return FlagEvaluator(MOCK_FLAGS, segments)

    def test_return_variation_if_rule_constraints_match(self, evaluator):
        user = UserIdentity(id='u1', traits={'email': 'bob@test.com'})
        assert evaluator.get_flag('feature-A', False, user) == True

    def test_return_default_if_rule_constraints_do_not_match(self, evaluator):
        user = UserIdentity(id='u2', traits={'email': 'bob@gmail.com'})
        assert evaluator.get_flag('feature-A', False, user) == False

    def test_handle_rollouts_deterministically(self, evaluator):
        # User 1 might be treatment, User 2 might be control depending on hash
        # We rely on hash stability. 
        # "feature-rollout:user-123" -> hash -> bucket
        userA = UserIdentity(id='user-123', traits={})
        valA = evaluator.get_flag('feature-rollout', 'control', userA)
        
        # Check same user gets same value
        assert evaluator.get_flag('feature-rollout', 'control', userA) == valA
