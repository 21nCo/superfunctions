import time
from typing import Any, Dict, List, Optional
from superfunctions.http import Route

from .models import WatchFnConfig, Event
from .storage.memory_storage import MemoryStorage
from .storage.database import DatabaseStorage
from .http.routes import create_routes
from .collectors.infra.system_metrics import SystemMetricsCollector
from .collectors.infra.process_metrics import ProcessMetricsCollector
from .utils.batching import Batcher

class WatchFn:
    def __init__(self, name: str, database=None, **kwargs):
        self.config = WatchFnConfig(name=name, **kwargs)
        self.is_started = False
        
        # Storage
        if self.config.storage == "database" and database:
            self.storage = DatabaseStorage(database)
        else:
            self.storage = MemoryStorage()

        # Batcher
        self.batcher = Batcher(on_flush=self._flush_events)

        # Collectors
        self.system_metrics = SystemMetricsCollector(self)
        self.process_metrics = ProcessMetricsCollector(self)

        # HTTP Routes
        self.http_routes: List[Route] = create_routes(self)

    def _flush_events(self, events: List[Event]):
        if hasattr(self.storage, 'add_batch'):
            self.storage.add_batch(events)
        else:
            for event in events:
                self.storage.add(event)

    def start(self):
        if self.is_started:
            return
        self.is_started = True
        self.batcher.start()
        # Enable collectors based on config
        self.system_metrics.start()
        self.process_metrics.start()

    def stop(self):
        self.is_started = False
        self.system_metrics.stop()
        self.process_metrics.stop()
        self.batcher.stop()

    def track(self, name: str, properties: Optional[Dict[str, Any]] = None):
        if not self.is_started:
            return
        event = Event(type="track", name=name, properties=properties or {})
        self.batcher.add(event)

    def capture_exception(self, error: Exception, context: Optional[Dict[str, Any]] = None):
        if not self.is_started:
            return
        event = Event(
            type="error", 
            properties={"message": str(error), "class": error.__class__.__name__},
            context=context or {}
        )
        self.batcher.add(event)
        
    def capture_message(self, message: str, context: Optional[Dict[str, Any]] = None):
        if not self.is_started:
            return
        event = Event(
            type="message",
            properties={"message": message},
            context=context or {}
        )
        self.batcher.add(event)

    def query(self, metric: Optional[str] = None) -> List[Event]:
        return self.storage.query(metric)

def watch_fn(name: str, **kwargs) -> WatchFn:
    return WatchFn(name, **kwargs)
