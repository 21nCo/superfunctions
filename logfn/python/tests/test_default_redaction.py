import asyncio
import json
from logfn import create_logger, dev_logger, server_logger
from logfn.sinks import SinkHttp
import pytest


def test_default_secret_keys_identities_and_nonmutation():
    events = []
    context = {'password': 'hunter2', 'headers': {'Authorization': 'Basic abc==', 'Cookie': 'session=private'}, 'nested': [{'api_key': 'opaque', 'refreshToken': 'refresh', 'safe': 'kept'}], 'tokenCount': 7}
    logger = create_logger('app', [events.extend], correlation={'userId': 'private-user', 'tenantId': 'private-tenant', 'traceId': 'a' * 32})
    logger.info('Authorization: Bearer a.b.c password=hidden contact=user@example.com', context)
    assert events[0]['ctx']['password'] == '[redacted]'
    assert events[0]['ctx']['nested'] == [{'api_key': '[redacted]', 'refreshToken': '[redacted]', 'safe': 'kept'}]
    assert events[0]['traceId'] == 'a' * 32
    encoded = json.dumps(events)
    for private in ['hunter2', 'abc==', 'private-user', 'private-tenant', 'a.b.c', 'hidden', 'user@example.com']:
        assert private not in encoded
    assert context['password'] == 'hunter2'


def test_terminal_pipeline_cycles_errors_and_isolated_sinks():
    events = []
    context = {'error': ValueError('token=error-secret')}
    context['self'] = context
    def inject(event):
        event['ctx']['token'] = 'pipeline-secret'
        event['extra'] = {'clientSecret': 'additional-secret'}
        return event
    def mutate(batch):
        batch[0]['ctx']['token'] = 'sink-secret'
    logger = create_logger('app', [mutate, events.extend], pipeline=[inject])
    logger.info('safe', context)
    encoded = json.dumps(events)
    for private in ['error-secret', 'pipeline-secret', 'additional-secret', 'sink-secret']:
        assert private not in encoded
    assert '[circular]' in encoded
    assert context['self'] is context
    assert 'token' not in context


def test_exact_allowlist_inheritance_and_mutation_isolation():
    events = []
    paths = ['/userId', '/ctx/safe/token', '/ctx/credentials', '/ctx/literal~1key/token']
    logger = create_logger('app', [events.extend], redaction={'allowlist': paths}, correlation={'userId': 'allowed', 'tenantId': 'private'})
    paths.extend(['/tenantId', '/ctx/unrelated/token'])
    logger.child().info('safe', {'safe': {'token': 'public'}, 'unrelated': {'token': 'private'}, 'credentials': {'token': 'still-private'}, 'literal/key': {'token': 'literal-public'}, 'literal': {'key': {'token': 'nested-private'}}})
    assert events[0]['userId'] == 'allowed'
    assert events[0]['tenantId'] == '[redacted]'
    assert events[0]['ctx'] == {'safe': {'token': 'public'}, 'unrelated': {'token': '[redacted]'}, 'credentials': '[redacted]', 'literal/key': {'token': 'literal-public'}, 'literal': {'key': {'token': '[redacted]'}}}
    for invalid in [False, {'allowlist': ['']}, {'allowlist': ['ctx/token']}, {'allowlist': ['/ctx/~bad']}]:
        with pytest.raises(TypeError):
            create_logger('app', [events.extend], redaction=invalid)


def test_actual_console_presets_and_serialization_bounds(capsys):
    dev_logger('app').info('password=dev-secret', {'token': 'dev-token'})
    server_logger('app').info('safe', {'password': 'server-secret'})
    output = capsys.readouterr().out
    for private in ['dev-secret', 'dev-token', 'server-secret']:
        assert private not in output
    assert '[redacted]' in output
    events = []
    create_logger('app', [events.extend]).info('x' * 64000, {str(index): {'token': 'a'} for index in range(500)})
    assert len(json.dumps(events[0]).encode()) <= 65536


async def test_actual_http_emits_terminal_masked_payload():
    received = []
    async def handle(reader, writer):
        headers = await reader.readuntil(b'\r\n\r\n')
        length = next(int(line.split(b':', 1)[1]) for line in headers.split(b'\r\n') if line.lower().startswith(b'content-length:'))
        received.append(json.loads(await reader.readexactly(length)))
        writer.write(b'HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        await writer.drain()
        writer.close()
        await writer.wait_closed()
    server = await asyncio.start_server(handle, '127.0.0.1', 0)
    sink = SinkHttp('http://127.0.0.1:' + str(server.sockets[0].getsockname()[1]), batch_size=100)
    try:
        logger = create_logger('app', [sink], pipeline=[lambda event: {**event, 'extra': {'private_key': 'pipeline-private'}}])
        logger.child().info('Bearer header.payload.signature', {'password': 'local-private'})
        await logger.flush()
        assert received[0]['events'][0]['msg'] == '[redacted]'
        assert received[0]['events'][0]['ctx']['password'] == '[redacted]'
        assert received[0]['events'][0]['extra']['private_key'] == '[redacted]'
    finally:
        await sink.close()
        server.close()
        await server.wait_closed()


def test_quoted_json_credentials_and_internal_reporter_context(capsys):
    events = []
    create_logger('app', [events.extend]).info(json.dumps({'password': 'json-secret"tail', 'token': 'json-token', 'authorization': 'Basic json-auth', 'safe': 'kept'}))
    for private in ['json-secret', 'tail', 'json-token', 'json-auth']:
        assert private not in events[0]['msg']
    assert 'kept' in events[0]['msg']
    def failed(event):
        raise RuntimeError('ignored')
    failed.__name__ = 'password=private-stage-name'
    create_logger('app', [events.extend], pipeline=[failed]).info('safe')
    assert 'private-stage-name' not in capsys.readouterr().err
