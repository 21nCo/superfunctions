import random
import re
import uuid
from typing import Any, Callable, Dict, List, Optional, Pattern, Union

from .types import LogEvent, PipelineStage, LogLevel

def redact(
    patterns: List[Union[str, Pattern[str]]],
    replacement: str = "[redacted]",
    keys: Optional[List[str]] = None
) -> PipelineStage:
    """
    Redact sensitive information from log messages and context values.
    """
    compiled_patterns = [re.compile(p) if isinstance(p, str) else p for p in patterns]
    
    def stage(event: LogEvent) -> LogEvent:
        # Redact message
        msg = event["msg"]
        for p in compiled_patterns:
            msg = p.sub(replacement, msg)
        event["msg"] = msg

        # Redact context values if they are strings
        if "ctx" in event and event["ctx"]:
            new_ctx = event["ctx"].copy()
            for k, v in new_ctx.items():
                if keys and k not in keys:
                    continue
                
                if isinstance(v, str):
                    for p in compiled_patterns:
                        v = p.sub(replacement, v)
                    new_ctx[k] = v
            event["ctx"] = new_ctx
            
        return event

    return stage

def enrich_context(
    static_ctx: Optional[Dict[str, Any]] = None,
    dynamic_ctx: Optional[Callable[[], Dict[str, Any]]] = None
) -> PipelineStage:
    """
    Add context to every log event.
    """
    def stage(event: LogEvent) -> LogEvent:
        ctx = event.get("ctx", {})
        if static_ctx:
            ctx.update(static_ctx)
        if dynamic_ctx:
            ctx.update(dynamic_ctx())
        event["ctx"] = ctx
        return event
    
    return stage

def sample(rates: Dict[LogLevel, float]) -> PipelineStage:
    """
    Sample log events based on level.
    Rate is 0.0 (drop all) to 1.0 (keep all).
    """
    def stage(event: LogEvent) -> Optional[LogEvent]:
        level = event["level"]
        rate = rates.get(level, 1.0)
        if rate >= 1.0:
            return event
        if rate <= 0.0:
            return None
        
        if random.random() < rate:
            return event
        return None
    
    return stage

def with_request_ids(
    generate_request_id: bool = True,
    generate_trace_id: bool = True
) -> PipelineStage:
    """
    Ensure traceId and requestId are present.
    In a real app, this might pull from contextvars.
    Here we just generate them if missing.
    """
    def stage(event: LogEvent) -> LogEvent:
        if generate_request_id and "requestId" not in event:
            event["requestId"] = str(uuid.uuid4())
        
        if generate_trace_id and "traceId" not in event:
            event["traceId"] = str(uuid.uuid4())
            
        return event
    
    return stage
