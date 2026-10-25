"""Equality indexes with per-event coverage; legacy rows always remain visible."""
import hashlib
import json
import math
import re
import struct

from superfunctions.db import FieldSchema, IndexSchema, TableSchema
from ..query import field, read


def index_table_name(table='watchfn_events'):
    if not isinstance(table, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', table):
        raise ValueError('Invalid WatchFn table name')
    if table == 'watchfn_events':
        return 'watchfn_log_index'
    name = table + '_log_index'
    return name if len(name) <= 63 else table[:40] + '_log_' + hashlib.sha256(table.encode()).hexdigest()[:10]


def get_log_index_schema(table='watchfn_events'):
    name = index_table_name(table)
    prefix = name if len(name) <= 40 else name[:28] + '_' + hashlib.sha256(name.encode()).hexdigest()[:10]
    return TableSchema(name=name, fields=[
        FieldSchema(name='id', type='string', primary_key=True, unique=True),
        FieldSchema(name='eventId', type='string'),
        FieldSchema(name='field', type='string'),
        FieldSchema(name='valueType', type='string'),
        FieldSchema(name='valueKey', type='string'),
    ], indexes=[IndexSchema(name=prefix + '_lookup', fields=['field', 'valueType', 'valueKey', 'eventId']),
                IndexSchema(name=prefix + '_event', fields=['eventId'])])


def scalar_key(value):
    if value is None:
        kind, raw = 'null', b''
    elif type(value) is bool:
        kind, raw = 'boolean', b'1' if value else b'0'
    elif type(value) is str:
        kind, raw = 'string', value.encode('utf-8')
    elif type(value) in (int, float):
        try:
            number = float(value)
        except OverflowError:
            return None
        if not math.isfinite(number):
            return None
        # The existing cross-language Query equality normalizes numbers to
        # IEEE754, including Python integers outside the safe-integer range.
        kind, raw = 'number', struct.pack('>d', 0.0 if number == 0 else number)
    else:
        return None
    return kind, hashlib.sha256(kind.encode() + b'\0' + raw).hexdigest()


def coverage(raw):
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        raise ValueError('Invalid log index coverage') from None
    if not isinstance(value, list) or len(value) > 32 or len(set(value)) != len(value):
        raise ValueError('Invalid log index coverage')
    for name in value:
        field(name)
    return value


def rows_for(identifier, payload, fields):
    if payload.get('type') != 'log':
        return []
    rows = []
    for name in fields:
        key = scalar_key(read(payload, name))
        if key is None:
            continue
        kind, value = key
        rows.append({'id': hashlib.sha256((identifier + '\0' + name).encode()).hexdigest(),
                     'eventId': identifier, 'field': name, 'valueType': kind, 'valueKey': value})
    return rows


def equality_filter(where):
    for name, condition in where.items():
        if name == 'type':
            continue
        value = condition
        if isinstance(condition, dict):
            if set(condition) != {'eq'}:
                continue
            value = condition['eq']
        key = scalar_key(value)
        if key is not None:
            return name, key
    return None
