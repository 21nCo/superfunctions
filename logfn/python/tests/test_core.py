import unittest
from datetime import datetime
from typing import List

from logfn.core import Logger, create_logger
from logfn.types import LogEvent

class MockSink:
    def __init__(self):
        self.events: List[LogEvent] = []
        
    def __call__(self, batch: List[LogEvent]):
        self.events.extend(batch)

class TestLogger(unittest.TestCase):
    def test_log_level(self):
        sink = MockSink()
        logger = create_logger("test", sinks=[sink], level="info")
        
        logger.debug("debug msg")
        logger.info("info msg")
        
        self.assertEqual(len(sink.events), 1)
        self.assertEqual(sink.events[0]["msg"], "info msg")
        self.assertEqual(sink.events[0]["level"], "info")

    def test_context_merge(self):
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

    def test_child_logger(self):
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

    def test_tags(self):
        sink = MockSink()
        logger = create_logger("test", sinks=[sink], base_tags=["a"])
        logger.info("msg", tags=["b"])
        
        self.assertEqual(sink.events[0]["tags"], ["a", "b"])

if __name__ == "__main__":
    unittest.main()
