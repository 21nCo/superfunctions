"""Stored canonical trace queries, sharing the generic event query engine."""
from copy import deepcopy
from ..query import Query, QueryValidationError, number

MAX_ROWS = 10000


class StoredTraceQuery(Query):
    _max_limit = MAX_ROWS + 1


def identifier(value, name):
    if not isinstance(value, str) or not value.strip() or len(value) > 1024:
        raise QueryValidationError('Invalid ' + name)
    return value


class TraceQueries:
    def __init__(self, query):
        self.query_events = query

    def query(self, options):
        if not isinstance(options, dict):
            raise QueryValidationError('Trace options must be an object')
        where = {'type': 'track'}
        for key, field in [('operation', 'name'), ('traceId', 'traceId'), ('service', 'service')]:
            if key in options:
                where['properties.' + field] = identifier(options[key], key)
        if 'status' in options:
            if options['status'] not in ('error', 'ok'):
                raise QueryValidationError('Invalid trace status')
            where['properties.tags.error'] = True if options['status'] == 'error' else {'neq': True}
        if 'duration' in options:
            duration = options['duration']
            filters = duration if isinstance(duration, dict) else {'eq': duration}
            if not filters or any(key not in ('eq', 'neq', 'gt', 'gte', 'lt', 'lte') or not number(value) or value < 0 for key, value in filters.items()):
                raise QueryValidationError('Invalid trace duration')
            where['properties.duration'] = duration
        query = {key: options[key] for key in ('timeRange', 'limit') if key in options}
        if 'orderBy' in options:
            order = options['orderBy']
            if not isinstance(order, dict) or order.get('field') not in ('duration', 'startTime', 'endTime', 'name', 'service', 'traceId'):
                raise QueryValidationError('Invalid trace order field')
            query['orderBy'] = {**order, 'field': 'properties.' + order['field']}
        events = self.query_events({**query, 'metric': 'trace.span', 'where': where})
        spans = []
        for event in events:
            span = event['properties']
            if not isinstance(span, dict) or any(not isinstance(span.get(key), str) for key in ('id', 'traceId', 'name')) or any(not number(span.get(key)) for key in ('startTime', 'endTime', 'duration')):
                raise QueryValidationError('Invalid stored trace span')
            for key in ('parentId', 'service'):
                if key in span and span[key] is not None:
                    identifier(span[key], 'stored ' + key)
            if 'tags' in span and not isinstance(span['tags'], dict):
                raise QueryValidationError('Invalid stored span tags')
            if 'logs' in span and not isinstance(span['logs'], list):
                raise QueryValidationError('Invalid stored span logs')
            spans.append(deepcopy(span))
        return spans

    def get_trace(self, options):
        if not isinstance(options, dict):
            raise QueryValidationError('Trace details options must be an object')
        trace_id = identifier(options.get('traceId'), 'traceId')
        for key in ('includeSpans', 'includeLogs'):
            if key in options and type(options[key]) is not bool:
                raise QueryValidationError('Invalid ' + key)
        spans = self.query({'traceId': trace_id, 'limit': MAX_ROWS + 1})
        if len(spans) > MAX_ROWS:
            raise QueryValidationError('Trace detail capacity exceeded')
        if not spans:
            return None
        if len({span['id'] for span in spans}) != len(spans):
            raise QueryValidationError('Duplicate stored span identity')
        spans.sort(key=lambda span: (span['startTime'], span['id']))
        start, end = min(span['startTime'] for span in spans), max(span['endTime'] for span in spans)
        result = dict(traceId=trace_id, startTime=start, endTime=end, duration=end-start, status='error' if any(span.get('tags', {}).get('error') is True for span in spans) else 'ok')
        if options.get('includeSpans'):
            result['spans'] = spans
        if options.get('includeLogs'):
            logs = self.query_events({'where': {'type': 'log', 'traceId': trace_id}, 'limit': MAX_ROWS + 1})
            if len(logs) > MAX_ROWS:
                raise QueryValidationError('Trace log capacity exceeded')
            result['logs'] = deepcopy(logs)
        return result

    def get_service_map(self, options):
        if not isinstance(options, dict):
            raise QueryValidationError('Service map options must be an object')
        minimum = options.get('minCalls', 1)
        if type(minimum) is not int or not 1 <= minimum <= 9007199254740991:
            raise QueryValidationError('minCalls must be a positive integer')
        spans = self.query({**{key: options[key] for key in ('timeRange',) if key in options}, 'limit': MAX_ROWS + 1})
        if len(spans) > MAX_ROWS:
            raise QueryValidationError('Service map capacity exceeded')
        by_id = {(span['traceId'], span['id']): span for span in spans}
        if len(by_id) != len(spans):
            raise QueryValidationError('Duplicate stored span identity')
        nodes, edges, unlinked = set(), {}, 0
        for span in spans:
            service = span.get('service')
            if not service:
                unlinked += 1
                continue
            nodes.add(service)
            if not span.get('parentId'):
                continue
            parent = by_id.get((span['traceId'], span['parentId']))
            if not parent or not parent.get('service'):
                unlinked += 1
                continue
            if parent['service'] == service:
                continue
            key = (parent['service'], service)
            edge = edges.setdefault(key, dict(source=key[0], target=key[1], calls=0, errors=0, totalDuration=0))
            edge['calls'] += 1
            edge['errors'] += span.get('tags', {}).get('error') is True
            edge['totalDuration'] += span['duration']
        result = []
        for key in sorted(edges):
            edge = edges[key]
            if edge['calls'] >= minimum:
                total = edge.pop('totalDuration')
                result.append({**edge, 'averageDuration': total / edge['calls']})
        return dict(nodes=[{'service': service} for service in sorted(nodes)], edges=result, unlinkedSpans=unlinked)
