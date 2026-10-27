"""Pipeline stages: redaction, enrichment, sampling and request ids."""

from __future__ import annotations

import random
import re
import secrets
from collections.abc import Callable, Iterable
from re import Pattern
from typing import Any, cast

from .redact import REDACTED, make_redactor
from .types import LogEvent, LogLevel, PipelineStage

# Default sampling rates per level (0 drops all, 1 keeps all)
DEFAULT_SAMPLING_RATES: dict[LogLevel, float] = {
    "error": 1.0,
    "fatal": 1.0,
    "warn": 1.0,
    "info": 0.1,
    "debug": 0.01,
    "trace": 0.0,
}

_TRACE_ID = re.compile(r"[0-9a-f]{32}", re.ASCII)
_SPAN_ID = re.compile(r"[0-9a-f]{16}", re.ASCII)
_FLAGS = re.compile(r"[0-9a-f]{2}", re.ASCII)


def redact(
    patterns: Iterable[str | Pattern[str]] | None = None,
    replacement: str = REDACTED,
    keys: Iterable[str] | None = None,
    allowlist: Iterable[str] | None = None,
) -> PipelineStage:
    """Redact credentials and personal data from the message, ctx (recursively,
    including exceptions), tags, userId and tenantId.

    ``patterns`` replaces the default extra patterns (email addresses); the
    built-in credential rules always run. ``keys`` adds sensitive key names and
    ``allowlist`` exempts exact paths such as ``user.email`` or ``userId``.
    """
    return make_redactor(patterns, replacement, keys, allowlist)


def enrich_context(
    static_ctx: dict[str, Any] | None = None,
    dynamic_ctx: Callable[[], dict[str, Any]] | None = None,
) -> PipelineStage:
    """Add fields to every event's ctx; the event's own ctx wins on conflicts."""

    def enrich_context_stage(event: LogEvent) -> LogEvent:
        enriched = cast(LogEvent, dict(event))
        enriched["ctx"] = {**(static_ctx or {}), **(dynamic_ctx() if dynamic_ctx else {}), **event.get("ctx", {})}
        return enriched

    return enrich_context_stage


def sample(
    rates: dict[LogLevel, float] | None = None,
    random_fn: Callable[[], float] | None = None,
) -> PipelineStage:
    """Keep each event with its level's rate, merged over DEFAULT_SAMPLING_RATES."""
    merged: dict[LogLevel, float] = {**DEFAULT_SAMPLING_RATES, **(rates or {})}
    draw = random_fn or random.random

    def sample_stage(event: LogEvent) -> LogEvent | None:
        rate = merged.get(event["level"], 1.0)
        if rate >= 1.0:
            return event
        if not rate > 0.0:  # also drops NaN
            return None
        return event if draw() < rate else None

    return sample_stage


def with_request_ids(generate_request_id: bool = True, generate_trace_id: bool = True) -> PipelineStage:
    """Add W3C-sized hex ids that are missing: requestId, and traceId with spanId."""

    def with_request_ids_stage(event: LogEvent) -> LogEvent:
        updated = cast(LogEvent, dict(event))
        if generate_request_id and "requestId" not in updated:
            updated["requestId"] = secrets.token_hex(16)
        if generate_trace_id and "traceId" not in updated:
            updated["traceId"] = secrets.token_hex(16)
            if "spanId" not in updated:
                updated["spanId"] = secrets.token_hex(8)
        return updated

    return with_request_ids_stage


def parse_w3c_trace_context(traceparent: str) -> dict[str, str] | None:
    """Parse a ``traceparent`` header (version 00) into traceId and spanId."""
    parts = traceparent.split("-")
    if len(parts) != 4 or parts[0] != "00":
        return None
    trace_id, span_id, flags = parts[1], parts[2], parts[3]
    if not _TRACE_ID.fullmatch(trace_id) or not _SPAN_ID.fullmatch(span_id) or not _FLAGS.fullmatch(flags):
        return None
    if set(trace_id) == {"0"} or set(span_id) == {"0"}:
        return None
    return {"traceId": trace_id, "spanId": span_id}
