"""W3C Trace Context level 1 participant, bounded to 512 characters per field."""
from dataclasses import dataclass
from typing import Optional
from secrets import token_hex
import re


@dataclass
class TraceContext:
    trace_id: str
    span_id: str
    parent_span_id: Optional[str] = None
    trace_flags: int = 1
    trace_state: Optional[str] = None


def _id(value, length):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{' + str(length) + '}', value) is not None and set(value) != {'0'}


def _state(value):
    if not isinstance(value, str) or len(value) > 512:
        return None
    members, seen = value.split(','), set()
    if len(members) > 32:
        return None
    for raw in members:
        member = raw.strip(' \t')
        if not member:
            continue
        key, separator, data = member.partition('=')
        if not separator or not re.fullmatch(r'(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})', key) or key in seen or not re.fullmatch(r'[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]', data):
            return None
        seen.add(key)
    return value


class TraceContextPropagator:
    def extract(self, headers):
        parents = self._values(headers, 'traceparent')
        if len(parents) != 1 or len(parents[0]) > 512:
            return None
        value = parents[0].strip(' \t')
        match = re.fullmatch(r'([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-([^\r\n]*))?', value)
        if not match or match[1] == 'ff' or (match[1] == '00' and len(value) != 55) or not _id(match[2], 32) or not _id(match[3], 16):
            return None
        state = _state(','.join(self._values(headers, 'tracestate')))
        return TraceContext(trace_id=match[2], span_id=match[3], trace_flags=int(match[4], 16) & 1, trace_state=state or None)

    def inject(self, context, headers=None):
        self._validate(context)
        headers = {} if headers is None else headers
        for key in list(headers):
            if key.lower() in ('traceparent', 'tracestate'):
                del headers[key]
        headers['traceparent'] = f'00-{context.trace_id}-{context.span_id}-{context.trace_flags & 1:02x}'
        if context.trace_state:
            headers['tracestate'] = context.trace_state
        return headers

    def create(self, parent_span_id=None):
        if parent_span_id is not None and not _id(parent_span_id, 16):
            raise ValueError('Invalid trace parent ID')
        return TraceContext(trace_id=token_hex(16), span_id=token_hex(8), parent_span_id=parent_span_id)

    def create_child(self, parent):
        self._validate(parent)
        return TraceContext(trace_id=parent.trace_id, span_id=token_hex(8), parent_span_id=parent.span_id, trace_flags=parent.trace_flags & 1, trace_state=parent.trace_state)

    @staticmethod
    def _validate(context):
        if not isinstance(context, TraceContext) or not _id(context.trace_id, 32) or not _id(context.span_id, 16) or type(context.trace_flags) is not int or not 0 <= context.trace_flags <= 255 or (context.trace_state is not None and _state(context.trace_state) is None):
            raise ValueError('Invalid trace context')

    @staticmethod
    def _values(headers, name):
        if not isinstance(headers, dict):
            return []
        result, length = [], 0
        for key, value in headers.items():
            if isinstance(key, str) and key.lower() == name:
                for item in value if isinstance(value, list) else [value]:
                    if not isinstance(item, str) or len(result) >= (1 if name == 'traceparent' else 32):
                        return []
                    length += len(item) + (1 if result else 0)
                    if length > 512:
                        return []
                    result.append(item)
        return result


trace_context_propagator = TraceContextPropagator()
