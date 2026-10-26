"""Legacy memory alerts plus process-local transactional created alerts.

list/get_record and notification APIs address created alerts only. get_all and
get_triggered include both families. evaluate_stored evaluates legacy alerts on
the first page, followed by the requested created-alert page; these are separate
commits, not an atomic operation spanning both registries.
"""
from threading import RLock
from uuid import uuid4

from .alert_manager import AlertManager
from .durable import AlertConflict, DurableAlertManager
from .lifecycle import owned_operation
from .schema import get_alert_schema
from ..storage.database import DatabaseStorage


class MemoryAlertManager(AlertManager):
    def __init__(self, snapshot, namespace, active, delivery):
        super().__init__(snapshot)
        self._namespace = namespace
        self._active = active
        self._delivery = delivery
        self._created = None
        self._created_ids = set()
        self._engine = None
        self._ownership = RLock()

    def _backend(self):
        with self._ownership:
            if not self._active():
                raise RuntimeError('WatchFn storage is unavailable')
            if self._created is None:
                from sqlalchemy import BigInteger, Column, Index, MetaData, String, Table, Text, create_engine
                from sqlalchemy.pool import StaticPool
                from superfunctions_sqlalchemy import create_adapter
                engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
                try:
                    metadata = MetaData()
                    from ..business.stored_funnels import get_business_schema
                    for schema in get_business_schema().values():
                        table = Table(schema.name, metadata, *[
                            Column(field.name, Text if field.type == 'text' else BigInteger if field.type == 'bigint' else String,
                                   primary_key=field.primary_key, nullable=field.nullable, unique=field.unique)
                            for field in schema.fields])
                        for index in schema.indexes or []:
                            Index(index.name, *[table.c[field] for field in index.fields], unique=index.unique)
                    metadata.create_all(engine)
                    storage = DatabaseStorage(create_adapter(engine))
                    created = DurableAlertManager(storage, self._snapshot, self._namespace,
                                                  active=self._active, delivery=self._delivery)
                    created._callbacks = self._callbacks
                    storage.start()
                except BaseException:
                    engine.dispose()
                    raise
                self._engine, self._created = engine, created
            return self._created

    @owned_operation
    def create_goal(self, options, app):
        from ..business.goals import goal_id,validate_goal
        goal=validate_goal(options);identifier=goal_id(app,goal['name'],'goal-alert')
        with self._ownership:
            if identifier in self.alerts:raise ValueError('Goal alert identity collides with legacy registration')
            result=self._backend().create_goal(goal, app)
            if goal.get('alerts',{}).get('notify_below_pace'):self._created_ids.add(identifier)
            return result

    @owned_operation
    def get_goal(self, name, app):
        return self._backend().get_goal(name, app)

    def start_storage(self):
        with self._ownership:
            if self._created is not None:
                self._created.storage.start()

    def close_storage(self):
        # Keep the StaticPool connection for same-instance restart. Closing the
        # owner loop drains admitted transactions, without destroying memory DB.
        with self._ownership:
            if self._created is not None:
                self._created.storage.close()

    @owned_operation
    def create(self, definition):
        with self._ownership:
            backend = self._backend()
            checked = backend._definition(definition)
            identifier = str(uuid4())
            if identifier in self.alerts or identifier in self._created_ids:
                raise AlertConflict('Alert ID already belongs to a legacy registration')
            # Reserve before I/O: an uncertain commit must never permit a
            # legacy registration to acquire this created-alert identity.
            self._created_ids.add(identifier)
            return backend._create(checked, identifier, False)

    def register(self, alert):
        with self._ownership:
            if alert.id in self._created_ids:
                raise AlertConflict('Alert ID already belongs to a created alert')
            return super().register(alert)

    def get(self, identifier):
        if identifier in self.alerts:
            return super().get(identifier)
        return self._created.get(identifier) if self._created is not None else None

    def get_all(self):
        return super().get_all() + (self._created.get_all() if self._created is not None else [])

    def get_triggered(self):
        return super().get_triggered() + (self._created.get_triggered() if self._created is not None else [])

    def enable(self, identifier):
        if identifier in self.alerts or self._created is None:
            return super().enable(identifier)
        return self._created.enable(identifier)

    def disable(self, identifier):
        if identifier in self.alerts or self._created is None:
            return super().disable(identifier)
        return self._created.disable(identifier)

    def remove(self, identifier):
        if identifier in self.alerts or self._created is None:
            return super().remove(identifier)
        return self._created.remove(identifier)

    @owned_operation
    def evaluate_stored(self, *, now=None, maximum=10000, limit=50, after=None):
        # Validate the created page before changing any legacy state.
        if self._created is not None:
            self._created._rows(limit, after)
        results = super().evaluate_stored(now=now, maximum=maximum) if after is None else []
        if self._created is not None:
            results.extend(self._created.evaluate_stored(now=now, maximum=maximum, limit=limit, after=after))
        return results

    def __getattr__(self, name):
        if name in ('list', 'get_record', 'trigger', 'trigger_async', 'resolve', 'resolve_async',
                    'acknowledge', 'update', 'add_note', 'notifications', 'process_notifications',
                    'reconcile_notification', 'receipt_retention_status', 'migrate_receipt_retention',
                    'prune_notifications'):
            return getattr(self._backend(), name)
        raise AttributeError(name)
