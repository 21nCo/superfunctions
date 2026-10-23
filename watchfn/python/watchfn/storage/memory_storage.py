from typing import List, Optional
from ..models import Event

class MemoryStorage:
    def __init__(self, limit: int = 1000):
        self.events: List[Event] = []
        self.limit = limit

    def add(self, event: Event):
        self.events.append(event)
        if len(self.events) > self.limit:
            self.events.pop(0)

    def query(self, metric: Optional[str] = None) -> List[Event]:
        if metric:
            return [e for e in self.events if e.name == metric]
        return self.events
        
    def get_all(self) -> List[Event]:
        return self.events
