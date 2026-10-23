import os
import time
import threading
try:
    import resource
except ImportError:
    resource = None

class ProcessMetricsCollector:
    def __init__(self, watch, interval=30):
        self.watch = watch
        self.interval = interval
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
            self._thread = None

    def _run(self):
        while not self._stop_event.is_set():
            self.collect()
            self._stop_event.wait(self.interval)

    def collect(self):
        data = {"pid": os.getpid()}
        if resource:
            usage = resource.getrusage(resource.RUSAGE_SELF)
            # ru_maxrss is in kilobytes on Linux, bytes on macOS. 
            # Normalizing strictly is hard without platform check, keeping raw.
            data["memory_rss"] = usage.ru_maxrss 
            data["cpu_user"] = usage.ru_utime
            data["cpu_system"] = usage.ru_stime
            
        self.watch.track("infra.process", data)
