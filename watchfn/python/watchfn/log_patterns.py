"""Deterministic, bounded stored-log template discovery."""
from datetime import datetime, timezone
import hashlib
import json
import re

from .query import Query, QueryValidationError, read, timestamp

MAX_EVENTS = 10000
MAX_BYTES = 16 * 1024 * 1024
VARIABLE = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?')
IDENTIFIER = re.compile(r'[A-Za-z0-9_]')


class StoredPatternQuery(Query):
    # Internal scans count every admitted candidate; public query limits stay unchanged.
    _max_limit = MAX_EVENTS


def pattern_tokens(value):
    try:
        if len(value.encode('utf-8')) > 16384:
            raise QueryValidationError('Invalid or oversized pattern field')
    except UnicodeEncodeError:
        raise QueryValidationError('Invalid or oversized pattern field') from None
    text = re.sub(r'[ \t\r\n\f\v]+', ' ', value).strip(' ')
    tokens, previous = [], 0
    for match in VARIABLE.finditer(text):
        start, end = match.span()
        if (start and IDENTIFIER.fullmatch(text[start-1])) or (end < len(text) and IDENTIFIER.fullmatch(text[end])):
            continue
        if start > previous:
            tokens.append({'type': 'literal', 'value': text[previous:start]})
        tokens.append({'type': 'uuid' if re.match(r'^[0-9a-fA-F]{8}-', match[0]) else 'number'})
        previous = end
    if previous < len(text) or not tokens:
        tokens.append({'type': 'literal', 'value': text[previous:]})
    return tokens


def render(tokens):
    return ''.join(token['value'].replace('\\', '\\\\').replace('<', '\\<') if token['type'] == 'literal'
                   else '<' + token['type'] + '>' for token in tokens)


_MISSING = object()


def stored_log_rows(events, time_range=_MISSING):
    query = StoredPatternQuery({'limit': MAX_EVENTS, 'where': {'type': 'log'}, **({'timeRange': time_range} if time_range is not _MISSING else {})})
    checked, size = [], 0
    for event in events:
        if len(checked) >= MAX_EVENTS:
            raise QueryValidationError('Pattern scan event limit exceeded')
        raw = event.model_dump_json().encode('utf-8')
        size += len(raw)
        if len(raw) > 65536 or size > MAX_BYTES:
            raise QueryValidationError('Pattern scan payload limit exceeded')
        checked.append(event)
    return query.execute(checked)


def discover_patterns(events, options):
    if not isinstance(options, dict) or set(options) - {'timeRange', 'minOccurrences', 'fields'}:
        raise QueryValidationError('Invalid pattern discovery options')
    minimum = options.get('minOccurrences', 5)
    if type(minimum) is not int or not 1 <= minimum <= MAX_EVENTS:
        raise QueryValidationError('Invalid minimum pattern occurrences')
    fields = options.get('fields', ['message'])
    if (not isinstance(fields, list) or not 1 <= len(fields) <= 8
            or any(type(name) is not str for name in fields) or len(set(fields)) != len(fields)):
        raise QueryValidationError('Invalid pattern fields')
    from .integrations.logfn import LogIntegrationConfig
    fields = LogIntegrationConfig(indexFields=fields).index_fields
    rows = stored_log_rows(events, options.get('timeRange', _MISSING))
    groups = {}
    for event in rows:
        for name in fields:
            value = read(event, name)
            if not isinstance(value, str):
                continue
            tokens = pattern_tokens(value)
            if len(tokens) == 1 and tokens[0] == {'type': 'literal', 'value': ''}:
                continue
            key = json.dumps([name, tokens], ensure_ascii=False, separators=(',', ':'))
            if key not in groups:
                if len(groups) >= 10000:
                    raise QueryValidationError('Pattern group limit exceeded')
                groups[key] = {'id': hashlib.sha256(key.encode('utf-8')).hexdigest(), 'field': name,
                               'pattern': render(tokens), 'tokens': tokens, 'count': 0,
                               'firstSeen': None, 'lastSeen': None, 'samples': []}
            group = groups[key]
            group['count'] += 1
            at = timestamp(event['timestamp'])
            group['firstSeen'] = min(group['firstSeen'] if group['firstSeen'] is not None else at, at)
            group['lastSeen'] = max(group['lastSeen'] if group['lastSeen'] is not None else at, at)
            if value not in group['samples']:
                group['samples'] = sorted(group['samples'] + [value], key=lambda item: item.encode('utf-8'))[:3]
    result = sorted((group for group in groups.values() if group['count'] >= minimum),
                    key=lambda group: (-group['count'], group['field'].encode('utf-8'), group['id']))
    if len(result) > 1000:
        raise QueryValidationError('Pattern result limit exceeded')
    for group in result:
        for name in ('firstSeen', 'lastSeen'):
            if group[name] is not None:
                group[name] = datetime.fromtimestamp(group[name] / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    return result
