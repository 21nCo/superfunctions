import threading
from typing import List, Optional
from ..models import Event


class MemoryStorage:
    def __init__(self, limit: int = 1000):
        if type(limit) is not int or limit <= 0:
            raise ValueError("Memory event limit must be a positive integer")
        self.events: List[Event] = []
        self.limit = limit
        self._lock = threading.Lock()

    def add(self, event: Event):
        self.add_batch([event])

    def add_batch(self, events: List[Event]):
        with self._lock:
            self.events = (self.events + events)[-self.limit:]

    def query(self, metric: Optional[str] = None) -> List[Event]:
        with self._lock:
            return [event.model_copy(deep=True) for event in self.events
                    if metric is None or event.name == metric]

    def get_all(self) -> List[Event]:
        return self.query()
