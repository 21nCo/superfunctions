"""Bounded structured queries over one admitted storage scan."""
from datetime import datetime, timezone
from decimal import Decimal
from functools import cmp_to_key
import json
import math
import re
import time

MISSING = object()


class QueryValidationError(ValueError):
    pass


def number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def field(path):
    if not isinstance(path, str) or not path.strip() or len(path) > 1024 or any(not part or part in ('__proto__', 'constructor', 'prototype') for part in path.split('.')):
        raise QueryValidationError('Invalid field')
    return path


def read(row, path):
    parts = path.split('.')
    value = row if parts[0] in row else row.get('properties', {})
    for part in parts:
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif isinstance(value, (list, str)) and part == 'length':
            value = len(value) if isinstance(value, list) else len(value.encode('utf-16-be', 'surrogatepass')) // 2
        elif isinstance(value, (list, str)) and re.fullmatch(r'0|[1-9]\d*', part):
            index = int(part)
            if isinstance(value, str):
                units = value.encode('utf-16-be', 'surrogatepass')
                if index >= len(units) // 2: return MISSING
                value = units[index * 2:index * 2 + 2].decode('utf-16-be', 'surrogatepass')
            else:
                if index >= len(value): return MISSING
                value = value[index]
        else:
            return MISSING
    return value


def js_string(value):
    if value is MISSING:
        return 'undefined'
    if value is None:
        return 'null'
    if type(value) is bool:
        return 'true' if value else 'false'
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ','.join('' if item is None else js_string(item) for item in value)
    if isinstance(value, dict):
        return '[object Object]'
    if type(value) in (int, float):
        value = float(value)
        if math.isnan(value):
            return 'NaN'
        if math.isinf(value):
            return 'Infinity' if value > 0 else '-Infinity'
        if value == 0:
            return '0'
        text = repr(value)
        if 1e-6 <= abs(value) < 1e21:
            return format(Decimal(text), 'f').rstrip('0').rstrip('.') if '.' in format(Decimal(text), 'f') else format(Decimal(text), 'f')
        mantissa, exponent = text.lower().split('e')
        return mantissa.removesuffix('.0') + 'e' + ('+' if int(exponent) >= 0 else '-') + str(abs(int(exponent)))
    return '[object Object]'


def js_number(value):
    if value is MISSING:
        return math.nan
    if value is None:
        return 0
    if type(value) is bool:
        return int(value)
    if type(value) in (int, float):
        try:
            return float(value)
        except OverflowError:
            return math.inf if value > 0 else -math.inf
    text = js_string(value).strip()
    if not text:
        return 0
    try:
        if re.fullmatch(r'0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+', text):
            return int(text, 0)
        if text in ('Infinity', '+Infinity', '-Infinity'):
            return float(text)
        if not re.fullmatch(r'[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?', text):
            return math.nan
        return float(text)
    except (ValueError, OverflowError):
        return math.nan


def equal(left, right):
    if left is MISSING or right is MISSING:
        return left is right
    if type(left) in (int, float) and type(right) in (int, float):
        return js_number(left) == js_number(right)
    return type(left) is type(right) and not isinstance(left, (list, dict)) and left == right


def sequential_sum(values):
    total = 0.0
    for value in values:
        total += value
    return total


def matches(row, filters):
    for path, condition in filters.items():
        value = read(row, path)
        operations = condition if isinstance(condition, dict) else {'eq': condition}
        for operation, expected in operations.items():
            if operation == 'eq' and not equal(value, expected): return False
            if operation == 'neq' and equal(value, expected): return False
            if operation == 'exists' and expected != (value is not MISSING and value is not None): return False
            if operation == 'contains' and (value is MISSING or value is None or expected not in js_string(value)): return False
            if operation in ('gt', 'gte', 'lt', 'lte'):
                if value is MISSING or value is None: return False
                actual = js_number(value)
                expected = float(expected)
                if not {'gt': actual > expected, 'gte': actual >= expected, 'lt': actual < expected, 'lte': actual <= expected}[operation]: return False
    return True


def timestamp(value):
    if number(value):
        return value
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc).timestamp() * 1000 if value.tzinfo is None else value.timestamp() * 1000
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is not None:
                return parsed.timestamp() * 1000
        except ValueError:
            pass
    raise QueryValidationError('Expected epoch milliseconds or timezone-aware ISO timestamp')


class Query:
    def __init__(self, options):
        if not isinstance(options, dict) or set(options) - {'metric', 'where', 'timeRange', 'groupBy', 'aggregations', 'orderBy', 'limit'}:
            raise QueryValidationError('Invalid query options')
        self.options = options
        metric = options.get('metric')
        if 'metric' in options and (not isinstance(metric, str) or not metric.strip()):
            raise QueryValidationError('Invalid metric')
        limit = options.get('limit', 1000)
        if type(limit) is not int or not 0 <= limit <= 1000:
            raise QueryValidationError('Limit must be between0 and1000')
        self.limit = limit
        filters = options.get('where', {})
        if not isinstance(filters, dict): raise QueryValidationError('Invalid filters')
        for path, condition in filters.items():
            field(path)
            if isinstance(condition, list): raise QueryValidationError('Invalid filter')
            if isinstance(condition, dict):
                if not condition or set(condition) - {'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'}: raise QueryValidationError('Invalid operator')
                for operator, value in condition.items():
                    if operator in ('gt', 'gte', 'lt', 'lte') and not number(value): raise QueryValidationError('Ordered filter requires finite number')
                    if operator == 'exists' and type(value) is not bool: raise QueryValidationError('Exists requires boolean')
                    if operator == 'contains' and not isinstance(value, str): raise QueryValidationError('Contains requires string')
        self.range = None
        if 'timeRange' in options:
            value = options['timeRange']
            if isinstance(value, dict) and set(value) == {'shortcut'}: value = value['shortcut']
            if isinstance(value, str):
                match = re.fullmatch(r'last-([1-9]\d*)(m|h|d|w)', value)
                if match:
                    duration = int(match[1]) * {'m':60000, 'h':3600000, 'd':86400000, 'w':604800000}[match[2]]
                    if duration > 9007199254740991: raise QueryValidationError('Range too large')
                    now = time.time() * 1000
                    self.range = (now - duration, now)
                else: self.range = (timestamp(value), time.time() * 1000)
            elif isinstance(value, list) and len(value) == 2:
                self.range = tuple(timestamp(item) for item in value)
            elif isinstance(value, dict) and value and not set(value) - {'from', 'to'}:
                self.range = (timestamp(value['from']) if 'from' in value else -math.inf, timestamp(value['to']) if 'to' in value else math.inf)
            else: raise QueryValidationError('Invalid time range')
            if self.range[0] > self.range[1]: raise QueryValidationError('Reversed time range')
        self.groups = []
        if 'groupBy' in options:
            values = options['groupBy'] if isinstance(options['groupBy'], list) else [options['groupBy']]
            if not values: raise QueryValidationError('Empty grouping')
            for value in values:
                if isinstance(value, str): self.groups.append((field(value), None))
                elif isinstance(value, dict) and set(value) == {'interval'} and isinstance(value['interval'], str):
                    match = re.fullmatch(r'([1-9]\d*)(ms|s|m|h|d|w)', value['interval'])
                    if not match: raise QueryValidationError('Invalid interval')
                    interval = int(match[1]) * {'ms':1, 's':1000, 'm':60000, 'h':3600000, 'd':86400000, 'w':604800000}[match[2]]
                    if interval > 9007199254740991: raise QueryValidationError('Interval too large')
                    self.groups.append(('timestamp', interval))
                else: raise QueryValidationError('Invalid grouping')
            if len({key for key, _ in self.groups}) != len(self.groups): raise QueryValidationError('Duplicate group')
        self.aggregations = options.get('aggregations')
        if self.groups and not self.aggregations: raise QueryValidationError('Grouping requires aggregation')
        if 'aggregations' in options:
            if not isinstance(self.aggregations, dict) or not self.aggregations: raise QueryValidationError('Invalid aggregations')
            for name, config in self.aggregations.items():
                field(name)
                if name in {key for key, _ in self.groups}: raise QueryValidationError('Aggregation/group collision')
                if not isinstance(config, dict) or set(config) - {'operation', 'field', 'percentile'} or config.get('operation') not in ('count', 'sum', 'avg', 'min', 'max', 'percentile', 'count_distinct'):
                    raise QueryValidationError('Unsupported aggregation')
                if config['operation'] != 'count' or 'field' in config: field(config.get('field'))
                if config['operation'] == 'percentile' and (not number(config.get('percentile')) or not 0 <= config['percentile'] <= 100): raise QueryValidationError('Invalid percentile')
        order = options.get('orderBy')
        if 'orderBy' in options:
            if not isinstance(order, dict) or set(order) != {'field', 'direction'} or order['direction'] not in ('asc', 'desc'): raise QueryValidationError('Invalid ordering')
            field(order['field'])

    def execute(self, events):
        rows = []
        for event in events:
            row = event.model_dump(mode='json')
            row['timestamp'] = (event.timestamp.replace(tzinfo=timezone.utc) if event.timestamp.tzinfo is None else event.timestamp).astimezone(timezone.utc).isoformat()
            metric = self.options.get('metric')
            if metric and row.get('name') != metric and row.get('type') != metric: continue
            if not matches(row, self.options.get('where', {})): continue
            if self.range and not self.range[0] <= timestamp(event.timestamp) <= self.range[1]: continue
            rows.append(row)
        if self.aggregations:
            groups = {} if self.groups else {(): ({}, [])}
            for row in rows:
                labels = {}
                for key, interval in self.groups:
                    value = math.floor(timestamp(row['timestamp']) / interval) * interval if interval else read(row, key)
                    if value is MISSING: value = None
                    if value is not None and not (isinstance(value, str) or type(value) is bool or number(value)): raise QueryValidationError('Group requires finite scalar')
                    labels[key] = value
                key = tuple(('number', float(value)) if number(value) else (type(value).__name__, value) for value in labels.values())
                if key not in groups: groups[key] = (labels, [])
                groups[key][1].append(row)
            rows = []
            for labels, members in groups.values():
                result = dict(labels)
                for name, config in self.aggregations.items():
                    operation = config['operation']
                    values = [read(row, config['field']) for row in members] if operation != 'count' else []
                    numeric = [float(value) for value in values if number(value)]
                    if operation == 'count': value = len(members)
                    elif operation == 'count_distinct':
                        distinct = set()
                        for item in values:
                            if item is MISSING or item is None: continue
                            if not (isinstance(item, str) or type(item) is bool or number(item)): raise QueryValidationError('Distinct requires finite scalar')
                            distinct.add(('number', float(item)) if number(item) else (type(item).__name__, item))
                        value = len(distinct)
                    elif operation == 'sum': value = sequential_sum(numeric)
                    elif not numeric: value = None
                    elif operation == 'avg': value = sequential_sum(item / len(numeric) for item in numeric)
                    elif operation == 'min': value = min(numeric)
                    elif operation == 'max': value = max(numeric)
                    else:
                        numeric.sort()
                        at = config['percentile'] / 100 * (len(numeric) - 1)
                        low, high = math.floor(at), math.ceil(at)
                        value = numeric[low] * (1 - (at - low)) + numeric[high] * (at - low)
                    if value is not None and not number(value): raise QueryValidationError('Nonfinite aggregation')
                    result[name] = value
                rows.append(result)
        order = self.options.get('orderBy')
        if order:
            def compare(left, right):
                def get(row): return row[order['field']] if self.aggregations and order['field'] in row else read(row, order['field'])
                a, b = get(left), get(right)
                if isinstance(a, str) and isinstance(b, str): a, b = a.encode('utf-16-be', 'surrogatepass'), b.encode('utf-16-be', 'surrogatepass')
                else: a, b = js_number(a), js_number(b)
                result = -1 if a < b else 1 if a > b else 0
                return result if order['direction'] == 'asc' else -result
            rows.sort(key=cmp_to_key(compare))
        return rows[:self.limit]
