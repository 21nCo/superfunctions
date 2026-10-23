import asyncio
import pytest
from browsefn import BrowseFn, BrowseFnConfig
from browsefn.core.errors import BrowseFnError
from browsefn.core.types import DestinationSecurity, GetPageOptions, ImageDownloadOptions
from browsefn.utils.destination_policy import normalize_policy_host, permits_private_host
from browsefn.web.public_page import fetch_public_page
from browsefn.images._download_utils import fetch_image_bytes
from browsefn.http.router import create_browsefn_router
from test_destination_policy import owned
from test_router import MockRequest, _route


def test_exact_normalization_and_no_suffix_match():
    assert normalize_policy_host('BÜCHER.Example.') == 'xn--bcher-kva.example'
    assert normalize_policy_host('[::ffff:127.0.0.1]') == '::ffff:7f00:1'
    assert permits_private_host('LOCALHOST.', DestinationSecurity(allowedHosts=['localhost']))
    assert not permits_private_host('child.localhost', DestinationSecurity(allowedHosts=['localhost']))


@pytest.mark.parametrize('host', ['*.example.com','https://example.com','example.com:80','user@example.com','127.1','0x7f000001','127.000.0.1','example..com','example.com..','[::1%lo0]'])
@pytest.mark.asyncio
async def test_malformed_hosts_fail_before_dns(host, monkeypatch):
    loop=asyncio.get_running_loop()
    async def no_dns(*_args, **_kwargs):
        pytest.fail('DNS must not run for malformed policy')
    monkeypatch.setattr(loop, 'getaddrinfo', no_dns)
    with pytest.raises(BrowseFnError) as error:
        await fetch_public_page('http://owned.test', GetPageOptions(security={'allowedHosts':[host]}))
    assert error.value.code == 'INVALID_ARGUMENT'


def test_malformed_arrays_fail_validation():
    for rules in ('localhost', [1], ('localhost',), None):
        with pytest.raises(ValueError):
            DestinationSecurity(allowedHosts=rules)


@pytest.mark.asyncio
async def test_allowed_dns_host_is_pinned_and_redirect_checked(owned, monkeypatch):
    base,calls=owned
    loop=asyncio.get_running_loop();original=loop.getaddrinfo;lookups=[]
    async def resolve(host,port,**kwargs):
        lookups.append(host)
        return await original('127.0.0.1',port,**kwargs)
    monkeypatch.setattr(loop,'getaddrinfo',resolve)
    html,_=await fetch_public_page(base.replace('127.0.0.1','Owned.Test.'),GetPageOptions(security={'allowedHosts':['owned.test']}))
    assert 'Owned fixture' in html and len(lookups)==1
    # A new literal destination has no inherited exception; denial precedes connect.
    with pytest.raises(BrowseFnError) as error:
        await fetch_public_page(base+'/private-redirect',GetPageOptions(security={'allowedHosts':['127.0.0.1']}))
    assert error.value.code=='SECURITY_POLICY_BLOCKED'
    assert calls==['/','/private-redirect']


@pytest.mark.asyncio
async def test_blocked_overrides_all_private_optins_before_dns(monkeypatch):
    loop=asyncio.get_running_loop()
    async def no_dns(*_args,**_kwargs):pytest.fail('blocked host resolved')
    monkeypatch.setattr(loop,'getaddrinfo',no_dns)
    for policy in ({'allowPrivateHosts':True},{'allowedHosts':['owned.test']}):
        with pytest.raises(BrowseFnError) as error:
            await fetch_public_page('http://owned.test',GetPageOptions(security={**policy,'blockedHosts':['OWNED.TEST.']}))
        assert error.value.code=='SECURITY_POLICY_BLOCKED'


@pytest.mark.asyncio
async def test_global_page_metadata_cache_and_router_precedence(owned,tmp_path):
    base,calls=owned
    browse=BrowseFn(BrowseFnConfig(security={'allowedHosts':['127.0.0.1']},cache={'enabled':True}))
    assert (await browse.web.get_page(base)).metadata.title=='Owned fixture'
    assert (await browse.web.get_multiple_metadata([base]))[0].success
    count=len(calls)
    with pytest.raises(BrowseFnError):
        await browse.web.get_page(base,{'security':{'blockedHosts':['127.0.0.1']}})
    routes=create_browsefn_router(browse)
    for path in ('/web/page','/images/download'):
        response=await _route(routes,path).handler(MockRequest(json_body={'url':base,'options':{'destination':str(tmp_path),'allowPrivateHosts':True,'security':{'allowPrivateHosts':True,'allowedHosts':['127.0.0.1']}}}),None)
        assert response.status==403
    assert len(calls)==count
    blocked=BrowseFn(BrowseFnConfig(security={'allowPrivateHosts':True,'blockedHosts':['127.0.0.1']}))
    with pytest.raises(BrowseFnError):
        await blocked.web.get_page(base,{'security':{'allowedHosts':['127.0.0.1'],'blockedHosts':[]}})
    with pytest.raises(BrowseFnError):
        await blocked.images.download(base,{'destination':str(tmp_path),'allowPrivateHosts':True})
    assert len(calls)==count


@pytest.mark.asyncio
async def test_actual_image_transport_exception_and_deny_precedence(owned):
    base,calls=owned
    assert await fetch_image_bytes(base,ImageDownloadOptions(security={'allowedHosts':['127.0.0.1']}))
    with pytest.raises(BrowseFnError):
        await fetch_image_bytes(base,ImageDownloadOptions(allowPrivateHosts=True,security={'blockedHosts':['127.0.0.1']}))
    with pytest.raises(BrowseFnError):
        await fetch_image_bytes(base+'/private-redirect',ImageDownloadOptions(security={'allowedHosts':['127.0.0.1']}))
    assert calls==['/','/private-redirect']

@pytest.mark.asyncio
async def test_idna_rule_at_actual_dns_boundary(owned,monkeypatch):
    base,calls=owned
    loop=asyncio.get_running_loop();original=loop.getaddrinfo;names=[]
    async def resolve(host,port,**kwargs):
        names.append(host)
        return await original('127.0.0.1',port,**kwargs)
    monkeypatch.setattr(loop,'getaddrinfo',resolve)
    await fetch_public_page(base.replace('127.0.0.1','bücher.example'),GetPageOptions(security={'allowedHosts':['XN--BCHER-KVA.EXAMPLE.']}))
    assert len(names)==1 and normalize_policy_host(names[0])=='xn--bcher-kva.example'
    assert calls==['/']


@pytest.mark.asyncio
async def test_mapped_ipv6_default_denial_and_explicit_exception(owned):
    base,calls=owned
    url=base.replace('127.0.0.1','[::ffff:127.0.0.1]')
    with pytest.raises(BrowseFnError):
        await fetch_public_page(url,GetPageOptions(security={}))
    assert calls==[]
    await fetch_public_page(url,GetPageOptions(security={'allowedHosts':['[::ffff:7f00:1]']}))
    assert calls==['/']
