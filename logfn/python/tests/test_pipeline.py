import unittest
from typing import Any, Optional

from logfn.pipeline import enrich_context, redact, sample
from logfn.types import LogEvent


class TestPipeline(unittest.TestCase):
    def make_event(self, msg: str = "test", ctx: Optional[dict[str, Any]] = None) -> LogEvent:
        return {
            "ts": "2023-01-01T00:00:00Z",
            "level": "info",
            "msg": msg,
            "name": "test",
            "ctx": ctx or {},
            "version": "0"
        }

    def test_redact(self) -> None:
        stage = redact(patterns=[r"secret-\d+"])
        event = self.make_event(msg="User secret-123 logged in", ctx={"key": "secret-456"})
        
        new_event = stage(event)
        assert new_event is not None
        self.assertEqual(new_event["msg"], "User [redacted] logged in")
        self.assertEqual(new_event["ctx"]["key"], "[redacted]")

    def test_enrich(self) -> None:
        stage = enrich_context(static_ctx={"env": "prod"})
        event = self.make_event()
        
        new_event = stage(event)
        assert new_event is not None
        self.assertEqual(new_event["ctx"]["env"], "prod")

    def test_sample_drop(self) -> None:
        stage = sample(rates={"info": 0.0})
        event = self.make_event()
        
        new_event = stage(event)
        self.assertIsNone(new_event)

if __name__ == "__main__":
    unittest.main()
