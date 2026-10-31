"""Consumer checks for an installed logfn wheel.

Run by tests/test_clean_consumer.py with an isolated interpreter (-I) from a
fresh virtual environment outside the repository:

    python -I clean_consumer.py <conformance_harness.py> <redaction-vectors.json>
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import logfn


def load_harness(path: str) -> Any:
    spec = importlib.util.spec_from_file_location("conformance_harness", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_installed_location() -> str:
    location = Path(logfn.__file__).resolve()
    assert "site-packages" in location.parts, f"logfn imported from {location}"
    return str(location.parent)


def check_enrichment_and_sampling() -> None:
    events: list[dict[str, Any]] = []
    draws = iter([0.1, 0.9])
    logger = logfn.create_logger(
        "consumer",
        level="debug",
        pipeline=[
            logfn.enrich_context({"service": "consumer"}, lambda: {"pid": 1}),
            logfn.sample({"debug": 0.5}, random_fn=lambda: next(draws, 0.99)),
        ],
        sinks=[events.extend],
    )
    logger.debug("kept by sampling")
    logger.debug("dropped by sampling")
    assert [e["msg"] for e in events] == ["kept by sampling"]
    assert events[0]["ctx"] == {"service": "consumer", "pid": 1}


class Collector:
    def __init__(self) -> None:
        self.received: list[dict[str, Any]] = []
        self.fail_next = 0
        collector = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers["Content-Length"]))
                if collector.fail_next > 0:
                    collector.fail_next -= 1
                    self.send_response(503)
                else:
                    collector.received.extend(json.loads(body)["events"])
                    self.send_response(204)
                self.end_headers()

            def log_message(self, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/ingest"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def check_bounded_delivery(collector: Collector) -> None:
    quiet = {"on_error": lambda error: None}

    bounded = logfn.SinkHttp(collector.url, batch_size=10, max_queue=3, **quiet)
    logger = logfn.create_logger("bounded", sinks=[bounded])
    for msg in "12345":
        logger.info(msg)
    assert bounded.stats()["queued"] == 3 and bounded.stats()["dropped"] == 2
    asyncio.run(logger.flush())
    assert [e["msg"] for e in collector.received] == ["3", "4", "5"]

    collector.received.clear()
    collector.fail_next = 1
    retrying = logfn.SinkHttp(collector.url, batch_size=1, retry_attempts=3, backoff_ms=5, **quiet)
    logfn.create_logger("secret", sinks=[retrying]).error("db postgres://svc:pw-1@db/app", api_key="ak-1")
    asyncio.run(retrying.flush())
    assert [e["msg"] for e in collector.received] == ["db postgres://[redacted]@db/app"]
    assert collector.received[0]["ctx"] == {"api_key": "[redacted]"}
    assert retrying.stats()["sent"] == 1


def check_failure_isolation() -> None:
    errors: list[str] = []

    def throwing(batch: list[Any]) -> None:
        raise RuntimeError("sync")

    unreachable = logfn.SinkHttp("http://127.0.0.1:9/ingest", batch_size=1, retry_attempts=1, timeout=2, on_error=lambda e: None)
    logger = logfn.create_logger("fragile", sinks=[throwing, unreachable], on_error=lambda e, c: errors.append(str(e)))
    logger.info("still fine")
    asyncio.run(logger.flush())
    assert errors == ["sync"]
    assert unreachable.stats()["dropped"] == 1


def check_default_logger_no_network() -> None:
    attempts: list[str] = []
    original = socket.socket.connect

    def spy(self: socket.socket, *args: Any) -> Any:
        attempts.append(repr(args))
        raise AssertionError("network I/O attempted")

    socket.socket.connect = spy  # type: ignore[method-assign]
    try:
        for logger in (logfn.create_logger("default"), logfn.dev_logger(), logfn.server_logger("server")):
            logger.error("token=abc", ValueError("boom"))
            asyncio.run(logger.flush())
    finally:
        socket.socket.connect = original  # type: ignore[method-assign]
    assert attempts == []


def main() -> None:
    harness_path, vectors_path = sys.argv[1], sys.argv[2]
    location = check_installed_location()
    check_enrichment_and_sampling()
    collector = Collector()
    try:
        check_bounded_delivery(collector)
    finally:
        collector.close()
    check_failure_isolation()
    check_default_logger_no_network()

    harness = load_harness(harness_path)
    vectors = harness.load_vectors(Path(vectors_path))
    for vector in vectors["vectors"]:
        harness.run_vector(logfn, vector)
    print(json.dumps({"consumer": "python", "ok": True, "logfn": location, "vectors": len(vectors["vectors"])}))


if __name__ == "__main__":
    main()
