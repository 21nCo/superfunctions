"""Local survey eligibility; service authorization and durable caps remain authoritative."""
import math
from typing import Dict, List, Optional, Set, Tuple

from ..types import Survey, SurveyResponse, UserIdentity
from ..utils.text import utf16_units
from .segments import SegmentEvaluator


class SurveyEngine:
    def __init__(self, segments: SegmentEvaluator):
        self.segments = segments
        self.surveys: Dict[str, Survey] = {}
        self.responses: Dict[str, Dict[str, int]] = {}
        self.receipts: Set[Tuple[str, str, str]] = set()

    def set_surveys(self, surveys: List[Survey]) -> None:
        self.surveys = {survey.id: survey for survey in surveys}

    def get_eligible_surveys(self, trigger_type: str, context: str,
                             user: Optional[UserIdentity]) -> List[Survey]:
        if user is None:
            return []
        eligible = []
        for survey in self.surveys.values():
            if not survey.enabled:
                continue
            matches = any(
                trigger.type == trigger_type and trigger.type in ('url_match', 'event')
                and (not trigger.pattern or utf16_units(trigger.pattern) in utf16_units(context))
                for trigger in survey.triggers
            )
            if not matches or (survey.segment_id and not self.segments.evaluate(survey.segment_id, user.traits)):
                continue
            # None represents the omitted optional field in Python dataclasses.
            cap = survey.caps.global_cap if survey.caps else None
            cap = 1 if cap is None else cap
            if (type(cap) not in (int, float) or not 0 <= cap <= 9007199254740991
                    or not math.isfinite(cap) or int(cap) != cap):
                continue
            if self.responses.get(user.id, {}).get(survey.id, 0) >= cap:
                continue
            eligible.append(survey)
        return eligible

    def track_response(self, response: SurveyResponse, user: UserIdentity,
                       receipt_id: Optional[str] = None) -> None:
        if receipt_id is not None:
            key = (user.id, response.survey_id, receipt_id)
            if key in self.receipts:
                return
            self.receipts.add(key)
        counts = self.responses.setdefault(user.id, {})
        counts[response.survey_id] = counts.get(response.survey_id, 0) + 1
