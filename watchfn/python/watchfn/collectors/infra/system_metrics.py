import os
import time
import threading
import platform

class SystemMetricsCollector:
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
        data = {
            "platform": platform.platform(),
            "processor": platform.processor(),
        }
        
        if hasattr(os, "getloadavg"):
            data["load_avg"] = os.getloadavg()
            
        if hasattr(os, "cpu_count"):
            data["cpu_count"] = os.cpu_count()

        self.watch.track("infra.system", data)
