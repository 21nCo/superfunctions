import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
import pytest
from browsefn import BrowseFn, BrowseFnConfig
from browsefn.core.errors import BrowseFnError
from browsefn.core.types import DestinationSecurity, GetPageOptions, ImageDownloadOptions
from browsefn.web.public_page import fetch_public_page
from browsefn.images._download_utils import fetch_image_bytes
from browsefn.utils.security_limits import download_limits
from browsefn.utils.destination_policy import merge_security
from browsefn.http.router import create_browsefn_router
from test_router import MockRequest, _route

@pytest.fixture
def limits_server():
    calls=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            calls.append(self.path)
            if self.path.startswith('/r') and int(self.path[2:])>0:
                self.send_response(302);self.send_header('Location',f'/r{int(self.path[2:])-1}');self.end_headers();return
            data=('é'*8 if self.path=='/utf8' else 'x'*(17 if self.path=='/overflow' else 16)).encode()
            self.send_response(200)
            if self.path!='/stream':self.send_header('Content-Length',str(len(data)))
            self.end_headers()
            try:self.wfile.write(data)
            except (BrokenPipeError,ConnectionResetError):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:yield f'http://127.0.0.1:{server.server_port}',calls
    finally:server.shutdown();server.server_close();thread.join()

@pytest.mark.asyncio
async def test_actual_body_boundaries(limits_server):
    base,_=limits_server
    for path in ['/','/utf8','/stream']:
        html,_=await fetch_public_page(base+path,GetPageOptions(security={'allowPrivateHosts':True,'maxResponseBytes':16}))
        assert len(html.encode())==16
        assert len(await fetch_image_bytes(base+path,ImageDownloadOptions(security={'allowPrivateHosts':True,'maxDownloadBytes':16})))==16
    for path in ['/overflow','/stream']:
        for image in [False,True]:
            with pytest.raises(BrowseFnError) as error:
                if image:await fetch_image_bytes(base+path,ImageDownloadOptions(security={'allowPrivateHosts':True,'maxDownloadBytes':15}))
                else:await fetch_public_page(base+path,GetPageOptions(security={'allowPrivateHosts':True,'maxResponseBytes':15}))
            assert error.value.code=='DOWNLOAD_TOO_LARGE'

@pytest.mark.asyncio
async def test_redirect_count_and_no_denied_target_request(limits_server):
    base,calls=limits_server
    for image in [False,True]:
        async def fetch(n):
            if image:return await fetch_image_bytes(base+'/r6',ImageDownloadOptions(security={'allowPrivateHosts':True,'maxRedirects':n}))
            return await fetch_public_page(base+'/r6',GetPageOptions(security={'allowPrivateHosts':True,'maxRedirects':n}))
        calls.clear()
        with pytest.raises(BrowseFnError):await fetch(0)
        assert calls==['/r6']
        calls.clear();await fetch(6);assert len(calls)==7
        calls.clear()
        with pytest.raises(BrowseFnError):await fetch(5)
        assert '/r0' not in calls

@pytest.mark.parametrize('name',['maxResponseBytes','maxDownloadBytes','maxRedirects'])
@pytest.mark.parametrize('value',[-1,1.5,'10',True,9007199254740992])
def test_malformed_constructor_limits(name,value):
    with pytest.raises(ValueError):BrowseFnConfig(security={name:value})

def test_limit_precedence_and_explicit_raised_limits():
    merged=merge_security(DestinationSecurity(maxResponseBytes=16,maxRedirects=2),DestinationSecurity(maxResponseBytes=32,maxRedirects=0))
    assert merged.max_response_bytes==16 and merged.max_redirects==0
    assert download_limits(ImageDownloadOptions(security={'maxDownloadBytes':30*1024*1024,'maxRedirects':6}))==(30*1024*1024,6)
    assert download_limits(ImageDownloadOptions(security={'maxDownloadBytes':16,'maxRedirects':2},maxPayloadBytes=32,maxRedirects=1))==(16,1)

@pytest.mark.asyncio
async def test_global_caps_formatted_expansion_and_colliding_cache(limits_server):
    base,calls=limits_server
    browse=BrowseFn(BrowseFnConfig(security={'allowedHosts':['127.0.0.1'],'maxResponseBytes':32},cache={'enabled':True,'keyGenerator':lambda *_args:'one-key'}))
    assert len((await browse.web.get_page(base,{'format':'text'})).content)==16
    with pytest.raises(BrowseFnError) as error:await browse.web.get_page(base,{'format':'text','security':{'maxResponseBytes':15}})
    assert error.value.code=='DOWNLOAD_TOO_LARGE' and len(calls)==1
    tiny=BrowseFn(BrowseFnConfig(security={'allowedHosts':['127.0.0.1'],'maxResponseBytes':16}))
    with pytest.raises(BrowseFnError):await tiny.web.get_page(base,{'format':'json'})
    with pytest.raises(BrowseFnError):await tiny.web.get_page(base+'/overflow',{'security':{'maxResponseBytes':100}})

@pytest.mark.asyncio
async def test_router_trusted_caps_and_strict_destination():
    real=BrowseFn(BrowseFnConfig(security={'maxDownloadBytes':30*1024*1024,'maxRedirects':6}))
    observed=[]
    async def download(_url,options):
        model=options;observed.append(model);return {'limits':download_limits(model)}
    router=create_browsefn_router(SimpleNamespace(get_security_limits=real.get_security_limits,images=SimpleNamespace(download=download)))
    response=await _route(router,'/images/download').handler(MockRequest(json_body={'url':'https://example.com','options':{'maxPayloadBytes':40*1024*1024,'maxRedirects':10,'security':{'allowPrivateHosts':True,'maxDownloadBytes':99*1024*1024}}}),None)
    assert response.status==200
    assert download_limits(observed[0])==(30*1024*1024,6)
    assert observed[0].security.allow_private_hosts is False and observed[0].security.allowed_hosts==[]

@pytest.mark.asyncio
async def test_transform_input_and_output_global_caps():
    from io import BytesIO
    from PIL import Image
    from browsefn.images._transform import transform_image
    output=BytesIO();Image.new('RGB',(8,8),'red').save(output,format='PNG');data=output.getvalue()
    jpeg,_=await transform_image(data,ImageDownloadOptions(format='jpeg'))
    assert len(jpeg)>len(data)
    for maximum in [len(data)-1,len(data)]:
        with pytest.raises(BrowseFnError) as error:await transform_image(data,ImageDownloadOptions(format='jpeg',security={'maxDownloadBytes':maximum}))
        assert error.value.code=='DOWNLOAD_TOO_LARGE'
