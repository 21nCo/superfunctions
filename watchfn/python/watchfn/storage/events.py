"""Validate native events and canonical owned business/log envelopes."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import math
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..models import Event

_NATIVE = {'type', 'name', 'timestamp', 'properties', 'context'}
_LEVELS = {'trace', 'debug', 'info', 'warn', 'error', 'fatal'}


class CanonicalApplication(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(strict=True, min_length=1, max_length=255)

    @field_validator('name')
    @classmethod
    def valid_name(cls, value):
        if not value.strip() or len(value.encode('utf-16-le')) // 2 > 255:
            raise ValueError('Invalid application identity')
        value.encode('utf-8')
        return value


class CanonicalBusinessEvent(Event):
    # Only these owned track envelopes gain app; ordinary Event serialization
    # remains byte-shape compatible and does not acquire an app:null field.
    model_config = ConfigDict(extra='forbid')
    type: Literal['track'] = 'track'
    name: str = Field(strict=True, min_length=1)
    app: CanonicalApplication

    @field_validator('timestamp')
    @classmethod
    def millisecond_precision(cls, value):
        if value.tzinfo is None: raise ValueError('Canonical track timestamp requires timezone')
        return value.replace(microsecond=(value.microsecond // 1000) * 1000)



def decode_event(payload):
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ValueError('Unsupported stored event shape')
    if value.get('type') == 'track' and 'app' in value:
        if (set(value) - (_NATIVE | {'app'}) or not {'type', 'name', 'timestamp', 'properties', 'app'}.issubset(value)
                or not isinstance(value['name'], str) or not value['name'].strip() or not isinstance(value['properties'], dict)):
            raise ValueError('Unsupported canonical track shape')
        stamp = value['timestamp']
        if type(stamp) in (int, float):
            if not math.isfinite(stamp): raise ValueError('Invalid canonical track timestamp')
            stamp = datetime.fromtimestamp(math.trunc(stamp) / 1000, timezone.utc)
        elif isinstance(stamp, str):
            stamp = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
        else: raise ValueError('Invalid canonical track timestamp')
        if stamp.tzinfo is None: raise ValueError('Canonical track timestamp requires timezone')
        value['timestamp'] = stamp.isoformat()
        return CanonicalBusinessEvent.model_validate_json(json.dumps(value), strict=True)
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
