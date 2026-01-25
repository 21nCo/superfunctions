import threading
import queue
import time
from typing import List, Any, Callable

class Batcher:
    def __init__(self, on_flush: Callable[[List[Any]], Any], max_size=100, max_wait=5.0):
        self.queue = queue.Queue()
        self.on_flush = on_flush
        self.max_size = max_size
        self.max_wait = max_wait
        self._stop_event = threading.Event()
        self._thread = None

    def start(self):
        if self._thread:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        if self._thread:
            self._thread.join()
            self.flush()

    def add(self, item: Any):
        self.queue.put(item)

    def _run(self):
        batch = []
        last_flush = time.time()

        while not self._stop_event.is_set():
            try:
                # Wait for item or timeout (flush interval)
                timeout = max(0.1, self.max_wait - (time.time() - last_flush))
                item = self.queue.get(timeout=timeout)
                batch.append(item)
            except queue.Empty:
                pass

            if len(batch) >= self.max_size or (time.time() - last_flush >= self.max_wait and batch):
                self.flush_batch(batch)
                batch = []
                last_flush = time.time()

    def flush_batch(self, batch):
        if not batch:
            return
        try:
            # This handles both sync and async functions if wrapped correctly, 
            # but usually on_flush here should be sync or run_until_complete.
            self.on_flush(batch)
        except Exception:
            pass
            
    def flush(self):
        # Manual flush logic (drain queue)
        batch = []
        while not self.queue.empty():
            try:
                batch.append(self.queue.get_nowait())
            except queue.Empty:
                break
        self.flush_batch(batch)
