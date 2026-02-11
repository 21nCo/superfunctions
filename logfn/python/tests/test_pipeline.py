import unittest
from logfn.types import LogEvent
from logfn.pipeline import redact, enrich_context, sample

class TestPipeline(unittest.TestCase):
    def make_event(self, msg="test", ctx=None) -> LogEvent:
        return {
            "ts": "2023-01-01T00:00:00Z",
            "level": "info",
            "msg": msg,
            "name": "test",
            "ctx": ctx or {},
            "version": "0"
        }

    def test_redact(self):
        stage = redact(patterns=[r"secret-\d+"])
        event = self.make_event(msg="User secret-123 logged in", ctx={"key": "secret-456"})
        
        new_event = stage(event)
        self.assertEqual(new_event["msg"], "User [redacted] logged in")
        self.assertEqual(new_event["ctx"]["key"], "[redacted]")

    def test_enrich(self):
        stage = enrich_context(static_ctx={"env": "prod"})
        event = self.make_event()
        
        new_event = stage(event)
        self.assertEqual(new_event["ctx"]["env"], "prod")

    def test_sample_drop(self):
        stage = sample(rates={"info": 0.0})
        event = self.make_event()
        
        new_event = stage(event)
        self.assertIsNone(new_event)

if __name__ == "__main__":
    unittest.main()
