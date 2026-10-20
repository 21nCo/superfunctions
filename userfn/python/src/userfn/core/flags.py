from typing import List, Dict, Optional, Any
from dataclasses import replace
from copy import deepcopy
import math
from ..types import (FlagConfig, FlagValue, FlagRule, FlagVariation, FlagPrerequisite,
                     FlagEnvironmentOverride, SegmentRule, UserIdentity, _Unset)
from .segments import SegmentEvaluator
from ..utils.hash import get_bucket

_UNAVAILABLE = object()


class FlagEvaluator:
    def __init__(self, initial_flags: List[FlagConfig], segment_evaluator: SegmentEvaluator,
                 environment: Optional[str] = None):
        if environment is not None and (not isinstance(environment, str) or not environment.strip()):
            raise TypeError("Flag environment must be a non-empty string")
        self.segments = segment_evaluator
        self.environment = environment
        self.flags: Dict[str, FlagConfig] = {}
        self.set_flags(initial_flags)

    def set_flags(self, flags: List[FlagConfig]):
        _validate_flags(flags)
        # Invalid replacements leave the previous configuration intact.
        snapshot = deepcopy(flags)
        self.flags = {flag.key: flag for flag in snapshot}

    def get_flag(self, key: str, default_value: FlagValue, user: Optional[UserIdentity] = None) -> FlagValue:
        resolved: Dict[str, Any] = {}
        active = set()
        stack: List[Dict[str, Any]] = [{"key": key, "next": 0}]

        def finish(result: Any):
            frame = stack.pop()
            active.discard(frame["key"])
            resolved[frame["key"]] = result

        # Per-call iterative DFS preserves user/environment context without recursion limits.
        while stack:
            frame = stack[-1]
            if "flag" not in frame:
                base = self.flags.get(frame["key"])
                if base is None or not base.enabled:
                    finish(_UNAVAILABLE)
                    continue
                override = base.environment_overrides.get(self.environment) if self.environment is not None else None
                effective = base
                if override is not None:
                    changes: Dict[str, Any] = {}
                    if override.enabled is not None:
                        changes["enabled"] = override.enabled
                    if override.default_value is not _Unset.VALUE:
                        changes["default_value"] = override.default_value
                    if override.default_variation_id is not _Unset.VALUE:
                        changes["default_variation_id"] = override.default_variation_id
                    if override.rules is not None:
                        changes["rules"] = override.rules
                    effective = replace(base, **changes)
                if not effective.enabled:
                    finish(_UNAVAILABLE)
                    continue
                frame["flag"] = effective
                active.add(frame["key"])
            flag = frame["flag"]
            if frame["next"] < len(flag.prerequisites):
                prerequisite = flag.prerequisites[frame["next"]]
                if prerequisite.key in active:
                    finish(_UNAVAILABLE)
                    continue
                if prerequisite.key not in resolved:
                    stack.append({"key": prerequisite.key, "next": 0})
                    continue
                result = resolved[prerequisite.key]
                if result is _UNAVAILABLE or not _json_equal(result, prerequisite.expected_value):
                    finish(_UNAVAILABLE)
                    continue
                frame["next"] += 1
            else:
                finish(self._evaluate_rules(flag, user))
        result = resolved[key]
        return default_value if result is _UNAVAILABLE else deepcopy(result)

    def _evaluate_rules(self, flag: FlagConfig, user: Optional[UserIdentity]) -> FlagValue:
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


def _validate_json(value: Any, ancestors=None):
    if value is None or isinstance(value, (bool, str)):
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            if math.isfinite(value):
                return
        except OverflowError:
            pass
        raise TypeError("Flag values must contain finite JSON numbers")
    if type(value) not in (dict, list):
        raise TypeError("Flag values must use plain JSON objects and arrays")
    ancestors = set() if ancestors is None else ancestors
    if id(value) in ancestors:
        raise TypeError("Flag values must be acyclic JSON values")
    ancestors.add(id(value))
    try:
        if isinstance(value, dict):
            if any(not isinstance(key, str) for key in value):
                raise TypeError("Flag object keys must be strings")
            values = value.values()
        else:
            values = value
        for child in values:
            _validate_json(child, ancestors)
    finally:
        ancestors.remove(id(value))


def _json_equal(left: Any, right: Any) -> bool:
    pairs = [(left, right)]
    while pairs:
        left, right = pairs.pop()
        if isinstance(left, bool) or isinstance(right, bool):
            if type(left) is not type(right) or left != right:
                return False
        elif isinstance(left, (int, float)) and isinstance(right, (int, float)):
            # Shared JSON follows JavaScript IEEE-754 numbers, not arbitrary-precision ints.
            try:
                left_number, right_number = float(left), float(right)
            except (OverflowError, ValueError):
                return False
            if not math.isfinite(left_number) or not math.isfinite(right_number) or left_number != right_number:
                return False
        elif type(left) is not type(right):
            return False
        elif isinstance(left, list):
            if len(left) != len(right):
                return False
            pairs.extend(zip(left, right))
        elif isinstance(left, dict):
            if left.keys() != right.keys():
                return False
            pairs.extend((left[key], right[key]) for key in left)
        elif left != right:
            return False
    return True


def _validate_flags(flags: List[FlagConfig]):
    def fail(message: str):
        raise TypeError("Invalid flag configuration: " + message)

    def text(value: Any) -> bool:
        return isinstance(value, str) and bool(value)

    operators = {"equals", "does_not_equal", "contains", "does_not_contain", "in", "not_in",
                 "exists", "does_not_exist", "gt", "gte", "lt", "lte", "regex"}
    if not isinstance(flags, list):
        fail("flags must be a list")
    keys = set()
    for flag in flags:
        if not isinstance(flag, FlagConfig) or not text(flag.key) or flag.key in keys:
            fail("flag keys must be unique non-empty strings")
        keys.add(flag.key)
        if not isinstance(flag.enabled, bool):
            fail("enabled must be boolean")
        _validate_json(flag.default_value)
        if not isinstance(flag.variations, list):
            fail("variations must be a list")
        variations = set()
        for variation in flag.variations:
            if not isinstance(variation, FlagVariation) or not text(variation.id) or variation.id in variations:
                fail("invalid or duplicate variation")
            variations.add(variation.id)
            _validate_json(variation.value)

        def variation_id(value: Any):
            if not text(value) or value not in variations:
                fail("unknown variation ID")

        if flag.default_variation_id is not None:
            variation_id(flag.default_variation_id)

        def rules(items: Any):
            if not isinstance(items, list):
                fail("rules must be a list")
            for rule in items:
                if not isinstance(rule, FlagRule) or not text(rule.id):
                    fail("invalid rule")
                if rule.segment_id is not None and not text(rule.segment_id):
                    fail("invalid segment ID")
                if rule.variation_id is not None:
                    variation_id(rule.variation_id)
                percentage = rule.rollout_percentage
                if percentage is not None and (isinstance(percentage, bool) or not isinstance(percentage, (int, float)) or percentage < 0 or percentage > 100 or not math.isfinite(percentage)):
                    fail("rollout must be between 0 and 100")
                if rule.constraints is not None:
                    if not isinstance(rule.constraints, list):
                        fail("constraints must be a list")
                    for constraint in rule.constraints:
                        if not isinstance(constraint, SegmentRule) or not text(constraint.id) or not text(constraint.field) or constraint.operator not in operators:
                            fail("invalid constraint")
                        _validate_json(constraint.value)

        rules(flag.rules)
        if not isinstance(flag.prerequisites, list):
            fail("prerequisites must be a list")
        for prerequisite in flag.prerequisites:
            if not isinstance(prerequisite, FlagPrerequisite) or not text(prerequisite.key):
                fail("invalid prerequisite")
            _validate_json(prerequisite.expected_value)
        if not isinstance(flag.environment_overrides, dict):
            fail("environment_overrides must be a dictionary")
        for environment, override in flag.environment_overrides.items():
            if not text(environment) or not environment.strip() or not isinstance(override, FlagEnvironmentOverride):
                fail("invalid environment override")
            if override.enabled is not None and not isinstance(override.enabled, bool):
                fail("override enabled must be boolean")
            if override.default_value is not _Unset.VALUE:
                _validate_json(override.default_value)
            if override.default_variation_id is not _Unset.VALUE and override.default_variation_id is not None:
                variation_id(override.default_variation_id)
            if override.rules is not None:
                rules(override.rules)
