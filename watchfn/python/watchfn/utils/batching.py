"""Threaded batching with shared pending state and serialized delivery."""

import math
import threading
import time
from collections import deque
from typing import Any, Callable, List


class Batcher:
    def __init__(self, on_flush: Callable[[List[Any]], Any], max_size=100, max_wait=5.0):
        if (isinstance(max_size, bool) or not isinstance(max_size, int) or max_size <= 0
                or not math.isfinite(max_wait) or max_wait <= 0):
            raise ValueError("Batch size and wait must be positive")
        self.on_flush = on_flush
        self.max_size = max_size
        self.max_wait = max_wait
        self._pending = deque()
        self._condition = threading.Condition()
        self._delivery = threading.Lock()
        self._stopped = True
        self._thread = None

    def start(self):
        with self._condition:
            if self._thread is not None:
                return
            self._stopped = False
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def stop(self):
        with self._condition:
            self._stopped = True
            self._condition.notify_all()
            thread = self._thread
        if thread is not None:
            thread.join()
        with self._condition:
            self._thread = None
        self.flush()

    def add(self, item: Any):
        with self._condition:
            self._pending.append(item)
            self._condition.notify_all()

    def _run(self):
        deadline = time.monotonic() + self.max_wait
        while True:
            with self._condition:
                while not self._stopped:
                    remaining = deadline - time.monotonic()
                    if len(self._pending) >= self.max_size or remaining <= 0:
                        break
                    self._condition.wait(remaining)
                if self._stopped:
                    return
            try:
                self.flush()
            except Exception:
                # Pending events are restored; explicit flush/stop surfaces errors.
                # Back off even when the size threshold remains exceeded.
                with self._condition:
                    self._condition.wait_for(lambda: self._stopped, self.max_wait)
            deadline = time.monotonic() + self.max_wait

    def flush_batch(self, batch):
        if batch:
            self.on_flush(batch)

    def flush(self):
        # A query/stop waits for any active delivery before reading storage.
        with self._delivery:
            with self._condition:
                count = len(self._pending)
            while count:
                with self._condition:
                    batch = [self._pending.popleft() for _ in range(min(count, self.max_size))]
                try:
                    self.flush_batch(batch)
                except BaseException:
                    with self._condition:
                        self._pending.extendleft(reversed(batch))
                    raise
                count -= len(batch)
