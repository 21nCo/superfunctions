"""Validate native Event envelopes and the canonical TypeScript log envelope."""
from copy import deepcopy
from datetime import datetime, timezone
import json

from ..models import Event

_NATIVE = {'type', 'name', 'timestamp', 'properties', 'context'}
_LEVELS = {'trace', 'debug', 'info', 'warn', 'error', 'fatal'}


def decode_event(payload):
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ValueError('Unsupported stored event shape')
    if not set(value) - _NATIVE:
        if not {'type', 'timestamp', 'properties', 'context'}.issubset(value):
            raise ValueError('Unsupported stored event shape')
        return Event.model_validate_json(payload, strict=True)
    # Only this published canonical log envelope permits additional structured
    # fields; unrelated event types retain the original strict shape validation.
    if (value.get('type') != 'log' or value.get('level') not in _LEVELS
            or not all(isinstance(value.get(key), str) for key in ('name', 'timestamp', 'message', 'service'))
            or not isinstance(value.get('properties'), dict) or not isinstance(value.get('ctx'), dict)):
        raise ValueError('Unsupported stored event shape')
    stamp = datetime.fromisoformat(value['timestamp'].replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('Invalid stored log timestamp')
    if 'ts' in value and value['ts'] != value['timestamp']:
        raise ValueError('Conflicting stored log timestamp')
    if 'msg' in value and value['msg'] != value['message']:
        raise ValueError('Conflicting stored log message')
    properties = deepcopy(value['properties'])
    properties.update({key: deepcopy(item) for key, item in value.items()
                       if key not in ('type', 'name', 'timestamp', 'properties', 'context')})
    for key in ('type', 'name', 'timestamp'):
        properties.pop(key, None)
    context = value.get('context', {})
    if not isinstance(context, dict):
        raise ValueError('Invalid stored log context')
    return Event(type='log', name=value['name'], timestamp=stamp, properties=properties, context=deepcopy(context))


def encode_event(event):
    value = event.model_dump(mode='json')
    stamp = event.timestamp
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    value['timestamp'] = stamp.astimezone(timezone.utc).isoformat()
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    if len(raw.encode('utf-8')) > 65536:
        raise OverflowError('Event exceeds database payload limit')
    return raw
