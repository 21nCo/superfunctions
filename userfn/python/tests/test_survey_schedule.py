import json
from pathlib import Path

import pytest

from userfn.core.segments import SegmentEvaluator
from userfn.core.surveys import SurveyEngine
from userfn.types import CampaignSchedule, CampaignTrigger, Survey, UserIdentity


VECTORS = json.loads((Path(__file__).parent / 'fixtures/survey-schedule.json').read_text())


@pytest.mark.parametrize('vector', VECTORS, ids=lambda vector: vector['name'])
def test_shared_schedule_vectors(vector):
    engine = SurveyEngine(SegmentEvaluator(), now=lambda: vector['now'])
    schedule = vector.get('schedule')
    value = Survey(id='scheduled', enabled=True, questions=[], triggers=[CampaignTrigger(type='event')],
                   schedule=CampaignSchedule(start_at=schedule.get('startAt'), end_at=schedule.get('endAt')) if schedule is not None else None)
    if vector.get('invalid'):
        with pytest.raises(ValueError, match='Invalid survey schedule'):
            engine.set_surveys([value])
    else:
        engine.set_surveys([value])
        assert bool(engine.get_eligible_surveys('event', '', UserIdentity('u', {}))) is vector['expected']
