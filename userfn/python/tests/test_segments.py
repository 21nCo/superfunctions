import pytest
from userfn.core.segments import SegmentEvaluator
from userfn.types import Segment, SegmentRule

class TestSegmentEvaluator:
    @pytest.fixture
    def evaluator(self):
        return SegmentEvaluator()

    def test_matches_simple_equality_rule(self, evaluator):
        segment = Segment(
            id='seg1',
            name='Test',
            rules=[SegmentRule(id='r1', field='plan', operator='equals', value='pro')]
        )
        evaluator.set_segments([segment])

        assert evaluator.evaluate('seg1', {'plan': 'pro'}) == True
        assert evaluator.evaluate('seg1', {'plan': 'free'}) == False

    def test_matches_regex(self, evaluator):
        segment = Segment(
            id='seg2',
            name='Test Regex',
            rules=[SegmentRule(id='r2', field='email', operator='regex', value=r'^.*@company\.com$')]
        )
        evaluator.set_segments([segment])

        assert evaluator.evaluate('seg2', {'email': 'bob@company.com'}) == True
        assert evaluator.evaluate('seg2', {'email': 'bob@gmail.com'}) == False

    def test_matches_numeric_comparisons(self, evaluator):
        segment = Segment(
            id='seg3',
            name='Test Numeric',
            rules=[SegmentRule(id='r3', field='age', operator='gte', value=18)]
        )
        evaluator.set_segments([segment])
        
        # Test numeric pass
        assert evaluator.evaluate('seg3', {'age': 20}) == True
        assert evaluator.evaluate('seg3', {'age': 18}) == True
        # Test numeric fail
        assert evaluator.evaluate('seg3', {'age': 10}) == False
        # Test string parsing if traits pass strings
        assert evaluator.evaluate('seg3', {'age': '25'}) == True 
