import json
import threading
import time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import pytest
from test_stored_funnels import open_watch
from watchfn.storage.events import decode_event


@pytest.fixture
def endpoint():
    state={'requests':0,'active':0,'maximum':0,'entered':threading.Event()}
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state['requests']+=1;state['active']+=1;state['maximum']=max(state['maximum'],state['active']);state['entered'].set()
            try:
                if self.path=='/retry' and state['requests']==1:body=b'failed';status=503
                else:body=b'healthy';status=200
                self.send_response(status);self.send_header('Content-Length',str(500 if self.path=='/stall' else len(body)));self.send_header('Set-Cookie','session=private-secret');self.end_headers()
                if self.path=='/slow':time.sleep(.04)
                if self.path=='/stall':time.sleep(.5)
                else:self.wfile.write(body)
            except (BrokenPipeError,ConnectionResetError):pass
            finally:state['active']-=1
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
    thread=threading.Thread(target=server.serve_forever);thread.start()
    try:yield f'http://127.0.0.1:{server.server_port}',state
    finally:server.shutdown();server.server_close();thread.join()


def check(url,**extra):return dict(name='health',type='http',url=url,interval='1h',timeout=1000,assertions=[dict(type='status',operator='eq',value=200)],**extra)


def wait_result(watch):
    end=time.monotonic()+3
    while time.monotonic()<end:
        rows=watch.storage.query('synthetics.check')
        if rows:return rows[0].properties
        time.sleep(.005)
    raise AssertionError('No owned synthetic result persisted')


def test_http_retry_snapshot_redaction_and_reports(endpoint):
    url,state=endpoint;w=open_watch('synthetic')
    try:
        options=check(url+'/retry',retries=1);created=w.synthetics.create(options);options['url']='http://invalid.invalid';created['name']='changed'
        result=wait_result(w);assert result['success'] and result['attempts']==2 and result['checkName']=='health'
        assert 'private-secret' not in json.dumps(result) and 'body' not in result['response']
        assert w.synthetics.get_uptime({'checkId':'health'})['uptime']==100
        assert w.synthetics.get_performance_trend({'checkId':'health','metric':'responseTime'})['buckets'][-1]['count']==1
        assert state['maximum']==1
    finally:w.stop()
    assert not any(t.name=='watchfn-synthetics' for t in threading.enumerate())
    with pytest.raises(RuntimeError):w.synthetics.create(check(url))


def test_deadline_body_cap_and_stop_cancellation(endpoint):
    url,state=endpoint;w=open_watch('synthetic')
    try:
        value=check(url+'/stall');value['timeout']=40;w.synthetics.create(value)
        assert wait_result(w)['error']=='Synthetic HTTP deadline exceeded'
    finally:w.stop()
    w=open_watch('synthetic')
    try:
        w.synthetics.create(check(url,maxResponseBytes=2));assert wait_result(w)['error']=='Synthetic response byte limit exceeded'
    finally:w.stop()
    state['entered'].clear();w=open_watch('synthetic');w.synthetics.create(check(url+'/stall'))
    assert state['entered'].wait(1);start=time.monotonic();w.stop();assert time.monotonic()-start<1
    assert not w.storage.query('synthetics.check')


def test_storage_failure_closes_then_surfaces_and_reentrant_stop_is_rejected(endpoint):
    url,_=endpoint;w=open_watch('synthetic');entered=threading.Event();original=w.storage.add
    def failing(event):
        with pytest.raises(RuntimeError,match='synthetic storage callback'):w.stop()
        assert w.is_started
        entered.set();raise RuntimeError('owned storage failure')
    w.storage.add=failing;w.synthetics.create(check(url));assert entered.wait(2)
    with pytest.raises(RuntimeError,match='persistence'):w.stop()
    assert not w.is_started and w.synthetics._thread is None
    w.storage.add=original;w.start();w.stop()


def test_stored_reports_dedup_incidents_foreign_app_and_reopen(tmp_path):
    from sqlalchemy import create_engine
    from superfunctions_sqlalchemy import create_adapter
    from test_database import migrate
    path='sqlite:///'+str(tmp_path/'synthetics.sqlite');engine=create_engine(path);migrate(engine)
    w=open_watch('synthetic',create_adapter(engine))
    for at,success,run in [(1000,False,'a'),(2000,False,'b'),(3000,True,'c'),(3000,True,'c')]:
        w.storage.add(decode_event(json.dumps(dict(type='track',name='synthetics.check',timestamp=at,app={'name':'synthetic'},properties=dict(checkId='health',runId=run,timestamp=at,success=success,duration=10)))))
    w.stop();engine.dispose();engine=create_engine(path);w=open_watch('synthetic',create_adapter(engine))
    try:
        options={'checkId':'health','timeRange':{'from':1500,'to':3000}}
        assert w.synthetics.get_uptime(options)['uptime']==50
        assert w.synthetics.get_incidents(options)==[dict(checkId='health',startedAt=1000,resolvedAt=3000,status='resolved',failures=2,leftCensored=True)]
        assert sum(b['count'] for b in w.synthetics.get_performance_trend(dict(options,metric='responseTime',interval=1000))['buckets'])==2
        assert w.synthetics.get_uptime(dict(options,checkId='absent'))['uptime'] is None
    finally:w.stop();engine.dispose()


def test_unsupported_and_validation_no_owned_thread():
    w=open_watch('synthetic')
    try:
        for value in [dict(check('http://localhost'),type='browser'),dict(check('http://localhost'),locations=[]),dict(check('http://localhost'),interval='0m')]:
            with pytest.raises(ValueError):w.synthetics.create(value)
        assert w.synthetics._thread is None
    finally:w.stop()


def test_simultaneous_stops_join_one_owned_loop(endpoint):
    from concurrent.futures import ThreadPoolExecutor
    url,state=endpoint;w=open_watch('synthetic');w.synthetics.create(check(url+'/stall'));assert state['entered'].wait(1)
    with ThreadPoolExecutor(2) as pool:
        stops=[pool.submit(w.synthetics.stop) for _ in range(2)]
        for stop in stops:stop.result(timeout=2)
    assert w.synthetics._thread is None;w.stop()


def test_report_rejects_conflicting_receipts_and_legacy_ownership():
    w=open_watch('synthetic')
    try:
        def event(success,owned=True):
            raw=dict(type='track',name='synthetics.check',timestamp=1000,properties=dict(checkId='health',runId='same',timestamp=1000,success=success,duration=1))
            if owned:raw['app']={'name':'synthetic'}
            else:raw['context']={}
            return decode_event(json.dumps(raw))
        w.storage.add(event(True));w.storage.add(event(False))
        with pytest.raises(ValueError,match='Conflicting'):w.synthetics.get_uptime({'checkId':'health','timeRange':{'from':0,'to':2000}})
    finally:w.stop()


def test_repeat_waits_for_completion_without_overlap(endpoint):
    url,state=endpoint;w=open_watch('synthetic')
    value=check(url+'/slow');value['interval']=10
    try:
        w.synthetics.create(value);end=time.monotonic()+2
        while state['requests']<3 and time.monotonic()<end:time.sleep(.005)
        assert state['requests']>=3 and state['maximum']==1
    finally:w.stop()


def test_thread_start_failure_leaves_no_owned_loop(monkeypatch):
    w=open_watch('synthetic')
    try:
        with monkeypatch.context() as patch:
            patch.setattr(threading.Thread,'start',lambda self:(_ for _ in ()).throw(RuntimeError('owned start failure')))
            with pytest.raises(RuntimeError,match='start failure'):w.synthetics.create(check('http://127.0.0.1:1'))
        assert w.synthetics._loop is None and w.synthetics._thread is None and not w.synthetics._checks
    finally:w.stop()
