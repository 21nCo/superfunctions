"""Stable root decision shared with TypeScript."""
import hashlib
import math


def sample_trace(trace_id, rate):
    if type(rate) not in (int, float) or not math.isfinite(rate) or not 0 <= rate <= 1:
        raise ValueError('Trace sample rate must be between 0 and 1')
    if not isinstance(trace_id, str):
        raise ValueError('Trace ID must be valid Unicode')
    try:
        encoded = trace_id.encode('utf-8')
    except UnicodeEncodeError:
        raise ValueError('Trace ID must be valid Unicode') from None
    return int.from_bytes(hashlib.sha256(encoded).digest()[:4], 'big') / 4294967296 < rate
