"""Process-local post-commit callbacks; durable delivery belongs to the outbox."""
import asyncio
from copy import deepcopy
import inspect
import threading
from contextlib import contextmanager
from functools import wraps
from contextvars import ContextVar

_listener_owner = ContextVar('watchfn_alert_listener_owner', default=None)


class LifecycleCallbacks:
    def __init__(self):
        self._listeners = {"triggered": [], "resolved": []}
        self._lock = threading.Condition()
        self._local = threading.local()
        self._active = 0
        self._closed = False

    @contextmanager
    def operation(self):
        with self._lock:
            depth = getattr(self._local, 'depth', 0)
            owner = _listener_owner.get()
            inherited = owner is not None and owner['manager'] is self and owner['active']
            if self._closed and not depth and not inherited:
                raise RuntimeError('Alert lifecycle is stopped')
            self._active += 1
            self._local.depth = depth + 1
        try:
            yield
        finally:
            with self._lock:
                self._local.depth -= 1
                self._active -= 1
                self._lock.notify_all()

    def start(self):
        with self._lock:
            if self._active:
                raise RuntimeError('Alert lifecycle operations are still active')
            self._closed = False

    def assert_can_stop(self):
        with self._lock:
            owner = _listener_owner.get()
            if getattr(self._local, 'depth', 0) or (owner is not None and owner['manager'] is self and owner['active']):
                raise RuntimeError('Cannot stop WatchFn from its alert callback')
    def stop(self):
        self.assert_can_stop()
        with self._lock:
            self._closed = True
            while self._active:
                self._lock.wait()

    def add(self, event, callback):
        if not callable(callback):
            raise TypeError("Alert listener must be callable")
        with self._lock:
            self._listeners[event].append(callback)

    def require_sync_context(self):
        with self._lock:
            registered = any(self._listeners.values())
        if registered:
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                return
            raise RuntimeError("Use the async alert lifecycle method when callbacks are registered in an active event loop")

    @contextmanager
    def callback_scope(self):
        owner = {'manager': self, 'active': True}
        token = _listener_owner.set(owner)
        try:
            yield
        finally:
            owner['active'] = False
            _listener_owner.reset(token)

    def emit(self, event, alert, context):
        with self._lock:
            callbacks = tuple(self._listeners.get(event, ()))
        failures = []
        for callback in callbacks:
            try:
                with self.callback_scope():
                    result = callback(deepcopy(alert), deepcopy(context))
                    if inspect.isawaitable(result):
                        try:
                            asyncio.get_running_loop()
                        except RuntimeError:
                            pass
                        else:
                            if inspect.iscoroutine(result): result.close()
                            raise RuntimeError('Async callback requires an alert worker context')
                        async def wait():
                            return await result
                        asyncio.run(wait())
            except (Exception, asyncio.CancelledError) as error:
                failures.append(error)
        if failures:
            # Do not expose potentially credential-bearing callback messages.
            raise RuntimeError("Alert transition committed; one or more listeners failed") from None


async def joined_call(operation, *args, **kwargs):
    """Cancellation cannot abandon an admitted transition or its callbacks."""
    task = asyncio.create_task(asyncio.to_thread(operation, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # Repeated cancellation still cannot abandon the owning worker.
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not task.cancelled():
            task.exception()  # Observe worker failure while preserving caller cancellation.
        raise


def owned_operation(method):
    @wraps(method)
    def call(self, *args, **kwargs):
        with self._callbacks.operation():
            return method(self, *args, **kwargs)
    return call
