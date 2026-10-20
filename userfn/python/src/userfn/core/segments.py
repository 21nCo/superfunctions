from ..utils.text import utf16_units
import math
from ..utils.json import json_equal, validate_json
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
        if type(traits) is not dict or not isinstance(rule.field, str) or any(not isinstance(key, str) for key in traits):
            return False
        keys = {utf16_units(key): key for key in traits}
        if len(keys) != len(traits):
            return False
        field = keys.get(utf16_units(rule.field))
        trait_value = traits[field] if field is not None else None
        operator, value = rule.operator, rule.value
        if operator == 'exists':
            return trait_value is not None
        if operator == 'does_not_exist':
            return trait_value is None
        if trait_value is None:
            return False
        try:
            if operator == 'equals':
                return json_equal(trait_value, value)
            if operator == 'does_not_equal':
                return not json_equal(trait_value, value)
            if operator in ('in', 'not_in'):
                if type(value) is not list:
                    return False
                validate_json(trait_value)
                validate_json(value)
                found = any(json_equal(trait_value, candidate) for candidate in value)
                return found if operator == 'in' else not found
            if operator in ('contains', 'does_not_contain', 'startsWith', 'regex'):
                if not isinstance(trait_value, str) or not isinstance(value, str):
                    return False
                if operator == 'contains':
                    return utf16_units(value) in utf16_units(trait_value)
                if operator == 'does_not_contain':
                    return utf16_units(value) not in utf16_units(trait_value)
                if operator == 'startsWith':
                    return utf16_units(trait_value).startswith(utf16_units(value))
                return bool(re.search(value, trait_value))
            if operator in ('gt', 'gte', 'lt', 'lte'):
                left, right = _finite_number(trait_value), _finite_number(value)
                if left is None or right is None:
                    return False
                if operator == 'gt':
                    return left > right
                if operator == 'gte':
                    return left >= right
                if operator == 'lt':
                    return left < right
                return left <= right
        except (TypeError, ValueError, OverflowError, RecursionError, re.error):
            return False
        return False


def _finite_number(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            result = float(value)
        except (OverflowError, ValueError):
            return None
        return result if math.isfinite(result) else None
    if not isinstance(value, str):
        return None
    text = value.strip(' \t\r\n\f\v')
    if not re.fullmatch(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?', text):
        return None
    result = float(text)
    return result if math.isfinite(result) else None
