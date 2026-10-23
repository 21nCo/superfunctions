import base64
from types import SimpleNamespace
import pytest
from browsefn.core.errors import BrowseFnError
from browsefn.core.types import ImageDownloadOptions, PageResult, PageMetadata
from browsefn.http.router import create_browsefn_router, _serialize_data
from browsefn.images._transform import transform_image
from browsefn.images._download_utils import fetch_image_bytes
from test_router import MockRequest, _route

MAXIMUM=10*1024*1024
@pytest.mark.asyncio
async def test_router_screenshot_exact_boundary_and_preencoding_rejection(monkeypatch):
    async def get_page(*_args):return PageResult(url='https://example.com',content='',metadata=PageMetadata(url='https://example.com'),provider='test',duration=0,screenshot=bytes(MAXIMUM//4*3))
    routes=create_browsefn_router(SimpleNamespace(web=SimpleNamespace(get_page=get_page)))
    response=await _route(routes,'/web/page').handler(MockRequest(json_body={'url':'https://example.com'}),None)
    assert response.status==200
    assert len(response.body['data']['screenshot'])==MAXIMUM
    async def oversized(*_args):return PageResult(url='https://example.com',content='',metadata=PageMetadata(url='https://example.com'),provider='test',duration=0,screenshot=bytes(MAXIMUM//4*3+1))
    def no_encode(*_args):pytest.fail('oversized screenshot must not be encoded')
    monkeypatch.setattr(base64,'b64encode',no_encode)
    routes=create_browsefn_router(SimpleNamespace(web=SimpleNamespace(get_page=oversized)))
    response=await _route(routes,'/web/page').handler(MockRequest(json_body={'url':'https://example.com'}),None)
    assert response.status==413
    assert response.body['error']['code']=='DOWNLOAD_TOO_LARGE'


def test_model_and_preencoded_screenshot_limits():
    for value in [{'screenshot':'a'*(MAXIMUM+1)}, {'screenshot':'é'*(MAXIMUM//2+1)}, PageResult(url='https://example.com',content='',metadata=PageMetadata(url='https://example.com'),provider='test',duration=0,screenshot=bytes(MAXIMUM//4*3+1))]:
        with pytest.raises(BrowseFnError) as error:_serialize_data(value)
        assert error.value.code=='DOWNLOAD_TOO_LARGE'


@pytest.mark.asyncio
async def test_image25mib_default_and_input_before_decode():
    assert ImageDownloadOptions().max_payload_bytes==25*1024*1024
    for size,options in [(25*1024*1024+1,ImageDownloadOptions()),(11,ImageDownloadOptions(maxPayloadBytes=10))]:
        with pytest.raises(BrowseFnError) as error:await transform_image(bytes(size),options)
        assert error.value.code=='DOWNLOAD_TOO_LARGE'


@pytest.mark.asyncio
async def test_owned_image_transfer_default_boundary():
    import threading
    from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_args):pass
        def do_GET(self):
            size=25*1024*1024+(0 if self.path=='/accepted' else 1)
            self.send_response(200)
            if self.path!='/streamed':self.send_header('Content-Length',str(size))
            self.end_headers()
            try:self.wfile.write(bytes(size))
            except (BrokenPipeError,ConnectionResetError):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        base=f'http://127.0.0.1:{server.server_port}'
        assert len(await fetch_image_bytes(base+'/accepted',ImageDownloadOptions(allowPrivateHosts=True)))==25*1024*1024
        for path in ['/declared','/streamed']:
            with pytest.raises(BrowseFnError) as error:await fetch_image_bytes(base+path,ImageDownloadOptions(allowPrivateHosts=True))
            assert error.value.code=='DOWNLOAD_TOO_LARGE'
    finally:server.shutdown();server.server_close();thread.join()
