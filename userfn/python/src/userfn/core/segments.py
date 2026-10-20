import re
from typing import Any, List, Optional, Dict
from ..types import Segment, SegmentRule, UserTraits, Operator

class SegmentEvaluator:
    def __init__(self, segments: Optional[List[Segment]] = None):
        self.segments: Dict[str, Segment] = {}
        if segments:
            for s in segments:
                self.segments[s.id] = s

    def set_segments(self, segments: List[Segment]):
        self.segments = {segment.id: segment for segment in segments}

    def evaluate(self, segment_id: str, traits: UserTraits) -> bool:
        segment = self.segments.get(segment_id)
        if not segment:
            return False
        return self.matches_segment(segment, traits)

    def matches_segment(self, segment: Segment, traits: UserTraits) -> bool:
        if not segment.rules:
            return True
        
        match_type = segment.match_type or 'all'
        
        if match_type == 'any':
            return any(self.matches_rule(rule, traits) for rule in segment.rules)
        else:
            return all(self.matches_rule(rule, traits) for rule in segment.rules)

    def matches_rule(self, rule: SegmentRule, traits: UserTraits) -> bool:
        trait_value = traits.get(rule.field)
        operator = rule.operator
        value = rule.value

        if operator == 'exists':
            return trait_value is not None
        
        if operator == 'does_not_exist':
            return trait_value is None

        if trait_value is None:
            return False

        # Convert to string for string comparisons if needed, 
        # but keep original type for numbers if possible.
        
        str_trait = str(trait_value)
        str_value = str(value) if value is not None else ""

        if operator == 'equals':
            return str_trait == str_value
        
        if operator == 'does_not_equal':
            return str_trait != str_value
        
        if operator == 'contains':
            return str_value in str_trait
        
        if operator == 'does_not_contain':
            return str_value not in str_trait
        
        if operator == 'in':
            return isinstance(value, list) and trait_value in value
        
        if operator == 'not_in':
            return isinstance(value, list) and trait_value not in value
        
        # Numeric comparisons
        if operator in ('gt', 'gte', 'lt', 'lte'):
            try:
                num_trait = float(trait_value)
                num_value = float(value)
                
                if operator == 'gt': return num_trait > num_value
                if operator == 'gte': return num_trait >= num_value
                if operator == 'lt': return num_trait < num_value
                if operator == 'lte': return num_trait <= num_value
            except (ValueError, TypeError):
                return False

        if operator == 'regex':
            try:
                return bool(re.search(str_value, str_trait))
            except re.error:
                return False

        return False
