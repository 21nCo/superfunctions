import json
from pathlib import Path
from datetime import datetime, timezone
import pytest
from watchfn import Event, WatchFn, QueryValidationError
from watchfn.query import Query

VECTORS = json.loads((Path(__file__).parent / 'fixtures/query-golden.json').read_text())


@pytest.mark.parametrize('vector', VECTORS['cases'], ids=lambda value: value['name'])
def test_supported_ts_golden_vectors(vector):
    events = [Event.model_validate(value) for value in vector.get('events', VECTORS['events'])]
    result = Query(vector['query']).execute(events)
    if vector['rawLabels']:
        result = [row['properties']['label'] for row in result]
    assert result == vector['expected']


@pytest.mark.parametrize('options', [
    {'groupBy':'endpoint'}, {'limit':True}, {'limit':1001}, {'where':{'x':{'gt':'1'}}},
    {'where':{'x':{'exists':1}}}, {'where':{'x':{'contains':1}}}, {'where':{'x':{'bad':1}}},
    {'where':{'constructor.x':1}}, {'groupBy':['x','x'],'aggregations':{'n':{'operation':'count'}}},
    {'aggregations':{'p':{'operation':'percentile','field':'value','percentile':101}}},
    {'aggregations':{'rate':{'operation':'rate'}}}, {'timeRange':{'from':2,'to':1}},
    {'timeRange':'today'}, {'timeRange':'last-0h'}, {'timeRange':'2026-01-01'},
    {'groupBy':{'interval':'0m'},'aggregations':{'n':{'operation':'count'}}},
    {'aggregations':{'x':{'operation':'sum'}}}, {'orderBy':{'field':'x','direction':'bad'}},
])
def test_validation(options):
    with pytest.raises(QueryValidationError): Query(options)


def test_legacy_and_structured_query_and_relative_range():
    watch = WatchFn('query')
    watch.storage.add(Event(type='track',name='recent',timestamp=datetime.now(timezone.utc),properties={'value':4}))
    assert isinstance(watch.query(metric='recent')[0], Event)
    assert watch.query({'metric':'recent','timeRange':'last-1h','aggregations':{'avg':{'operation':'avg','field':'value'}}}) == [{'avg':4}]
    assert len(watch.query({'metric':'track'})) == 1


def test_invalid_query_does_not_flush_and_nonfinite_aggregate_fails():
    watch = WatchFn('query')
    watch.batcher.add(Event(type='track',name='pending'))
    with pytest.raises(QueryValidationError): watch.query({'unknown':True})
    assert watch.storage.query() == []
    query = Query({'aggregations':{'sum':{'operation':'sum','field':'value'}}})
    with pytest.raises(QueryValidationError): query.execute([Event(type='track',properties={'value':1e308})]*2)
