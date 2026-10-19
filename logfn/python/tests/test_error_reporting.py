import pytest
from logfn import create_logger


def test_pipeline_and_sync_sink_errors_reach_inherited_callback():
    errors = []
    def stage(event):
        raise ValueError('stage')
    def sink(batch):
        raise RuntimeError('sink')
    logger = create_logger('test', [sink], pipeline=[stage], on_error=lambda error, context: errors.append((error, context)))
    logger.child().info('hello')
    assert [type(error) for error, _ in errors] == [ValueError, RuntimeError]
    assert errors[0][1] == {'stage': 'stage'}
    assert errors[1][1] == {'sink': 'sink'}


def test_callback_failures_and_recursive_logging_do_not_escape(capsys):
    calls = []
    def sink(batch):
        raise ValueError('sink')
    def callback(error, context):
        calls.append(error)
        logger.child().info('recursive')
        raise RuntimeError('callback')
    logger = create_logger('test', [sink], on_error=callback)
    logger.info('hello')
    assert len(calls) == 1
    assert 'error callback failed' in capsys.readouterr().err


@pytest.mark.asyncio
async def test_async_failures_are_reported_and_flush_still_rejects():
    errors = []
    async def sink(batch):
        raise ValueError('delivery')
    logger = create_logger('test', [sink], on_error=lambda error, context: errors.append((error, context)))
    logger.child().info('hello')
    with pytest.raises(ValueError, match='delivery'):
        await logger.flush()
    assert len(errors) == 1
    assert errors[0][1] == {'sink': 'sink'}


@pytest.mark.asyncio
async def test_each_failed_flush_is_reported_and_healthy_sink_runs():
    errors = []; healthy = []
    class Broken:
        def __call__(self, batch): pass
        async def flush(self): raise ValueError('flush')
    class Healthy:
        def __call__(self, batch): pass
        async def flush(self): healthy.append(True)
    logger = create_logger('test', [Broken(), Healthy()], on_error=lambda error, context: errors.append(context))
    with pytest.raises(ValueError): await logger.flush()
    assert healthy == [True]
    assert errors == [{'sink': 'Broken', 'phase': 'flush'}]
