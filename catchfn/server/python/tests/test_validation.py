import pytest
from pydantic import ValidationError

from catchfn.types import BugReportEvent


def test_attachment_and_app_validation():
    report = BugReportEvent.model_validate(
        {
            "id": "one",
            "timestamp": 1,
            "title": "Bug",
            "severity": "high",
            "app": {"name": "shop"},
            "steps": ["Click"],
            "attachments": [
                {
                    "id": "shot",
                    "name": "shot.png",
                    "type": "image/png",
                    "size": 1,
                    "kind": "screenshot",
                    "annotationScene": {"version": 1, "elements": []},
                }
            ],
        }
    )
    assert report.model_dump()["attachments"][0]["annotationScene"]["version"] == 1
    assert report.steps == ["Click"]
    with pytest.raises(ValidationError):
        BugReportEvent.model_validate(
            {
                "id": "one",
                "timestamp": 1,
                "title": "Bug",
                "severity": "high",
                "app": "invalid",
            }
        )
