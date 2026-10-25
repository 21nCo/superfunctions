import time
from threading import RLock
from typing import Any, Dict, List, Optional, overload
from superfunctions.http import Route

from .models import WatchFnConfig, Event
from .query import Query, Aggregate
from .trace.tracer import Tracer
from .trace.queries import StoredTraceQuery
from .alerts.alert_manager import AlertManager
from .alerts.durable import DurableAlertManager
from .alerts.observations import observations
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
        self._trace_admission = RLock()
        
        # Storage
        if self.config.storage == "database":
            if database is None:
                raise ValueError("Database storage requires an adapter")
            self.storage = DatabaseStorage(database)
        else:
            self.storage = MemoryStorage()

        # Batcher
        self.batcher = Batcher(on_flush=self._flush_events)

        # Collectors
        self.system_metrics = SystemMetricsCollector(self)
        self.process_metrics = ProcessMetricsCollector(self)

        self._alerts = None
        self.trace = Tracer(self.config.name, self._record_trace, self._query_traces)

        # HTTP Routes
        self.http_routes: List[Route] = create_routes(self)

    def _record_trace(self, name, properties):
        with self._trace_admission:
            if not self.is_started:
                raise RuntimeError("WatchFn storage is unavailable")
            self.batcher.add(Event(type="track", name=name, properties=properties))

    def _query_traces(self, options):
        if not self.is_started:
            raise RuntimeError("WatchFn storage is unavailable")
        # Stored-only queries do not join delivery or lifecycle callback work.
        return StoredTraceQuery(options).execute(self.storage.query())

    @property
    def alerts(self):
        if self._alerts is None:
            self._alerts = DurableAlertManager(self.storage, self._alert_snapshot, self.config.name, active=lambda: self.is_started, delivery=self.config.alerts) if isinstance(self.storage, DatabaseStorage) else AlertManager(snapshot=self._alert_snapshot)
            if not self.is_started:
                self._alerts._callbacks.stop()
        return self._alerts

    def _alert_snapshot(self, requested, now, maximum):
        if not self.is_started:
            raise RuntimeError("WatchFn storage is unavailable")
        self.batcher.flush()
        events = self.storage.query()
        return {key: observations(events, key[0], start, now, maximum)
                for key, start in requested.items()}

    def _flush_events(self, events: List[Event]):
        if hasattr(self.storage, 'add_batch'):
            self.storage.add_batch(events)
        else:
            for event in events:
                self.storage.add(event)

    def start(self):
        if self.is_started:
            return
        if isinstance(self.storage, DatabaseStorage):
            self.storage.start()
        if self._alerts is not None:
            self._alerts._callbacks.start()
        with self._trace_admission:
            self.is_started = True
        self.batcher.start()
        # Enable collectors based on config
        self.system_metrics.start()
        self.process_metrics.start()

    def stop(self):
        if self._alerts is not None:
            self._alerts._callbacks.stop()
        with self._trace_admission:
            self.is_started = False
        self.system_metrics.stop()
        self.process_metrics.stop()
        try:
            self.batcher.stop()
        finally:
            if isinstance(self.storage, DatabaseStorage):
                self.storage.close()

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

    @overload
    def query(self, metric: Dict[str, Any]) -> List[Dict[str, Any]]: ...

    @overload
    def query(self, metric: Optional[str] = None) -> List[Event]: ...

    def query(self, metric=None):
        if isinstance(metric, dict):
            query = Query(metric)
            self.batcher.flush()
            return query.execute(self.storage.query())
        self.batcher.flush()
        return self.storage.query(metric)

    def aggregate(self, options: Dict[str, Any]) -> List[Dict[str, Any]]:
        query = Aggregate(options)
        self.batcher.flush()
        return query.execute(self.storage.query())

def watch_fn(name: str, **kwargs) -> WatchFn:
    return WatchFn(name, **kwargs)
