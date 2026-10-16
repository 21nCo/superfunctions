import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest
from browsefn import browse_fn, BrowseFnConfig

@pytest.mark.asyncio
async def test_rotation_and_credential_persistence_scan(tmp_path):
    agents = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args): pass
        def do_GET(self):
            agents.append(self.headers.get('User-Agent'))
            self.send_response(200); self.end_headers(); self.wfile.write(b'<p>safe response</p>')
    server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread = threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    try:
        browser = browse_fn(BrowseFnConfig(web={'userAgents':['agent-a','agent-b'],'providers':{'cheerio':{'apiKey':'provider-secret-123'}}},cache={'enabled':True,'storage':'file','directory':str(tmp_path)}))
        url = f'http://127.0.0.1:{server.server_port}'
        options = {'headers':{'Authorization':'authorization-secret-123'},'cookies':[{'name':'session','value':'cookie-secret-123'}]}
        await browser.web.get_page(url,options)
        await browser.web.get_page(url,{**options,'headers':{**options['headers'],'uSeR-aGeNt':'explicit'}})
        await browser.web.get_page(url,options)
        await browser.web.get_page(url,options) # cache hit for agent-a
        await browser.web.get_page(url+'?token=url-secret-123',options)
        assert agents == ['agent-a','explicit','agent-b','agent-b']
        persisted=''.join(file.read_text() for file in tmp_path.rglob('*') if file.is_file())
        logs=json.dumps([entry.model_dump() for entry in browser.get_logs()],default=str)
        for secret in ['provider-secret-123','authorization-secret-123','cookie-secret-123','url-secret-123']:
            assert secret not in persisted+logs
        assert 'safe response' in persisted
    finally:
        server.shutdown();server.server_close();thread.join()


def test_provider_error_log_redacts_known_credentials_and_embedded_url_tokens():
    from browsefn.middleware.logging import Logger
    logger = Logger()
    logger.register_secrets({'apiKey':'provider-secret-123','headers':{'Authorization':'authorization-secret-123'},'cookies':[{'value':'cookie-secret-123'}]})
    logger.error('error',{'error':'provider-secret-123 authorization-secret-123 cookie-secret-123 request https://example.com?token=url-secret-123 failed'})
    evidence=json.dumps([entry.model_dump() for entry in logger.get_logs()],default=str)
    for secret in ['provider-secret-123','authorization-secret-123','cookie-secret-123','url-secret-123']:
        assert secret not in evidence
