import threading
from typing import List, Optional
from ..models import Event
from .log_index import rows_for, equality_filter


class MemoryStorage:
    def __init__(self, limit: int = 1000):
        if type(limit) is not int or limit <= 0:
            raise ValueError("Memory event limit must be a positive integer")
        self.events: List[Event] = []
        self.limit = limit
        self._lock = threading.Lock()
        self._log_index = {}

    def add(self, event: Event):
        self.add_batch([event])

    def add_batch(self, events: List[Event]):
        with self._lock:
            retained = (self.events + [event.model_copy(deep=True) for event in events])[-self.limit:]
            index = {}
            for event in retained:
                if event._log_index_fields is not None:
                    for row in rows_for(event._storage_id, event.model_dump(mode='json'), event._log_index_fields):
                        key = (row['field'], row['valueType'], row['valueKey'])
                        index.setdefault(key, set()).add(event._storage_id)
            self.events, self._log_index = retained, index

    def query(self, metric: Optional[str] = None) -> List[Event]:
        with self._lock:
            return [event.model_copy(deep=True) for event in self.events
                    if metric is None or event.name == metric]

    def get_all(self) -> List[Event]:
        return self.query()

    def query_logs(self, where):
        selected = equality_filter(where)
        if selected is None:
            return self.query()
        name, (kind, value) = selected
        with self._lock:
            matched = self._log_index.get((name, kind, value), set())
            return [event.model_copy(deep=True) for event in self.events
                    if event._log_index_fields is None or name not in event._log_index_fields
                    or event._storage_id in matched]
