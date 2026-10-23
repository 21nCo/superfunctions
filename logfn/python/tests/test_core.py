import unittest

from logfn.core import create_logger
from logfn.types import LogEvent


class MockSink:
    def __init__(self) -> None:
        self.events: list[LogEvent] = []
        
    def __call__(self, batch: list[LogEvent]) -> None:
        self.events.extend(batch)

class TestLogger(unittest.TestCase):
    def test_log_level(self) -> None:
        sink = MockSink()
        logger = create_logger("test", sinks=[sink], level="info")
        
        logger.debug("debug msg")
        logger.info("info msg")
        
        self.assertEqual(len(sink.events), 1)
        self.assertEqual(sink.events[0]["msg"], "info msg")
        self.assertEqual(sink.events[0]["level"], "info")

    def test_context_merge(self) -> None:
        sink = MockSink()
        logger = create_logger(
            "test", 
            sinks=[sink], 
            level="info",
            base_context={"env": "prod"}
        )
        
        logger.info("msg", user_id="123")
        
        self.assertEqual(sink.events[0]["ctx"]["env"], "prod")
        self.assertEqual(sink.events[0]["ctx"]["user_id"], "[redacted]")

    def test_child_logger(self) -> None:
        sink = MockSink()
        logger = create_logger(
            "test", 
            sinks=[sink], 
            level="info",
            base_context={"env": "prod"}
        )
        
        child = logger.child(ctx={"module": "auth"})
        child.info("login")
        
        event = sink.events[0]
        self.assertEqual(event["ctx"]["env"], "prod")
        self.assertEqual(event["ctx"]["module"], "auth")

    def test_tags(self) -> None:
        sink = MockSink()
        logger = create_logger("test", sinks=[sink], base_tags=["a"])
        logger.info("msg", tags=["b"])
        
        self.assertEqual(sink.events[0]["tags"], ["a", "b"])

if __name__ == "__main__":
    unittest.main()
