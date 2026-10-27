"""A local HTTP server answering requests from a queue and recording what it received (mirrors
__tests__/helpers.ts FixtureServer)."""

from __future__ import annotations

import socket
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


@dataclass
class RecordedRequest:
    method: str
    path: str
    query: str
    headers: dict[str, str]
    body: bytes


@dataclass
class ScriptedResponse:
    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)
    body: str = ""
    destroy: bool = False
    """Close the connection without a response."""
    delay: float = 0
    """Seconds to wait before answering."""


def scripted(entry: dict[str, Any]) -> ScriptedResponse:
    """A response from a vector entry (status, headers, body) or a test's (destroy, delayMs)."""
    return ScriptedResponse(
        status=entry.get("status", 200),
        headers=dict(entry.get("headers", {})),
        body=entry.get("body", ""),
        destroy=entry.get("destroy", False),
        delay=entry.get("delayMs", 0) / 1000,
    )


class FixtureServer:
    def __init__(self) -> None:
        self.requests: list[RecordedRequest] = []
        self._queue: list[ScriptedResponse] = []
        self._lock = threading.Lock()
        server = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: Any) -> None:
                pass

            def _read_body(self) -> bytes:
                if self.headers.get("transfer-encoding", "").lower() == "chunked":
                    data = bytearray()
                    while True:
                        size = int(self.rfile.readline().split(b";")[0].strip(), 16)
                        if size == 0:
                            while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                                pass
                            return bytes(data)
                        data += self.rfile.read(size)
                        self.rfile.readline()
                length = int(self.headers.get("content-length", "0") or 0)
                return self.rfile.read(length) if length else b""

            def _handle(self) -> None:
                body = self._read_body()
                path, _, query = self.path.partition("?")
                headers: dict[str, str] = {}
                for name, value in self.headers.items():
                    key = name.lower()
                    headers[key] = f"{headers[key]}, {value}" if key in headers else value
                with server._lock:
                    server.requests.append(RecordedRequest(self.command, path, query, headers, body))
                    response = server._queue.pop(0) if server._queue else ScriptedResponse(200, {"content-type": "application/json"}, "{}")
                if response.delay:
                    time.sleep(response.delay)
                if response.destroy:
                    self.close_connection = True
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    return
                payload = response.body.encode("utf-8")
                try:
                    self.send_response(response.status)
                    for name, value in response.headers.items():
                        self.send_header(name, value)
                    if response.status not in (204, 304) and not any(name.lower() == "content-length" for name in response.headers):
                        self.send_header("content-length", str(len(payload)))
                    self.end_headers()
                    if self.command != "HEAD" and response.status not in (204, 304):
                        self.wfile.write(payload)
                except OSError:
                    # The client gave up (a timeout) before the response was written.
                    self.close_connection = True

            do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = do_TRACE = _handle

        class Server(ThreadingHTTPServer):
            daemon_threads = True

            def handle_error(self, request: Any, client_address: Any) -> None:
                pass

        self._server = Server(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        port = self._server.server_address[1]
        self.base_url = f"http://127.0.0.1:{port}/v1"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def reset(self, responses: list[ScriptedResponse] | None = None) -> None:
        with self._lock:
            self.requests.clear()
            self._queue = list(responses or [])
