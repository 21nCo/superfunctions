from typing import List, Dict, Optional, Any
from ..types import FlagConfig, FlagValue, FlagRule, UserIdentity
from .segments import SegmentEvaluator
from ..utils.hash import get_bucket

class FlagEvaluator:
    def __init__(self, initial_flags: List[FlagConfig], segment_evaluator: SegmentEvaluator):
        self.flags: Dict[str, FlagConfig] = {f.key: f for f in initial_flags}
        self.segments = segment_evaluator

    def set_flags(self, flags: List[FlagConfig]):
        self.flags = {f.key: f for f in flags}

    def get_flag(self, key: str, default_value: FlagValue, user: Optional[UserIdentity] = None) -> FlagValue:
        flag = self.flags.get(key)
        
        if not flag:
            return default_value
        
        if not flag.enabled:
            return default_value
        
        # Evaluate rules in order
        for rule in flag.rules:
            # 1. Check constraints
            if not self._matches_constraints(rule, user):
                continue
            
            # 2. Check Rollout
            if rule.rollout_percentage is not None:
                if rule.rollout_percentage < 100:
                    if not user:
                        # Cannot bucket anonymous user without ID, skip rule? 
                        # TS implementation continues if user is missing, effectively skipping.
                        continue
                    
                    bucket = get_bucket(flag.key, user.id)
                    # Bucket is 0-99. 
                    # If rollout is 10%, we want buckets 0-9. 
                    # So if bucket >= rollout, we skip.
                    if bucket >= rule.rollout_percentage:
                        continue

            # 3. Return Variation
            if rule.variation_id:
                variation = next((v for v in flag.variations if v.id == rule.variation_id), None)
                if variation:
                    return variation.value
            
            # If no variation ID but matched, maybe just fall through?
            # TS says "continue"
            continue

        # Fallback
        if flag.default_variation_id:
            variation = next((v for v in flag.variations if v.id == flag.default_variation_id), None)
            if variation:
                return variation.value

        return flag.default_value

    def _matches_constraints(self, rule: FlagRule, user: Optional[UserIdentity] = None) -> bool:
        if not user:
            # Anonymous matching: allowed only if no constraints defined
            if rule.segment_id or (rule.constraints and len(rule.constraints) > 0):
                return False
            return True

        # Check Segment
        if rule.segment_id:
            matches_segment = self.segments.evaluate(rule.segment_id, user.traits)
            if not matches_segment:
                return False

        # Check Inline Constraints
        if rule.constraints:
            matches_constraints = all(
                self.segments.matches_rule(c, user.traits) for c in rule.constraints
            )
            if not matches_constraints:
                return False

        return True
