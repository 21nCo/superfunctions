import asyncio
import pytest
from userfn import UserFnClient, UserFnOptions, FeedbackSubmission, FeedbackReceipt, FeedbackDeliveryError


def feedback():
    return FeedbackSubmission(title='Bug', body='It crashes', category='bug', tags=['unicode 文'], attachments=['https://example.test/image'])


def test_unconfigured_does_not_acknowledge_or_log(capsys):
    client = UserFnClient(UserFnOptions(api_key='key'))
    with pytest.raises(FeedbackDeliveryError, match='not configured'):
        asyncio.run(client.submit_feedback(feedback()))
    assert capsys.readouterr().out == ''


def test_awaits_acceptance_with_current_identity():
    async def run():
        gate = asyncio.Event()
        calls = []
        class Service:
            async def submit(self, submission, context):
                calls.append((submission, context))
                await gate.wait()
                return FeedbackReceipt(id='feedback-1', accepted=True)
        client = UserFnClient(UserFnOptions(api_key='key', feedback_service=Service()))
        client.identify('user-1', {'plan': 'pro'})
        value = feedback()
        task = asyncio.create_task(client.submit_feedback(value))
        await asyncio.sleep(0)
        assert not task.done()
        assert calls[0][0] == value
        assert calls[0][1].source == 'in_app'
        assert calls[0][1].user.id == 'user-1'
        gate.set()
        await task
        client.reset()
        await client.submit_feedback(value)
        assert calls[-1][1].user is None
    asyncio.run(run())


def test_service_failure_propagates():
    class Service:
        async def submit(self, submission, context):
            raise RuntimeError('storage unavailable')
    client = UserFnClient(UserFnOptions(api_key='key', feedback_service=Service()))
    with pytest.raises(RuntimeError, match='storage unavailable'):
        asyncio.run(client.submit_feedback(feedback()))


@pytest.mark.parametrize('receipt', [None, FeedbackReceipt(id='one', accepted=False), FeedbackReceipt(id='', accepted=True)])
def test_invalid_receipt_rejected(receipt):
    class Service:
        async def submit(self, submission, context):
            return receipt
    client = UserFnClient(UserFnOptions(api_key='key', feedback_service=Service()))
    with pytest.raises(FeedbackDeliveryError, match='did not acknowledge'):
        asyncio.run(client.submit_feedback(feedback()))


def test_validation_before_delivery():
    class Service:
        async def submit(self, submission, context):
            pytest.fail('invalid feedback must not reach the service')
    client = UserFnClient(UserFnOptions(api_key='key', feedback_service=Service()))
    with pytest.raises(ValueError, match='requires'):
        asyncio.run(client.submit_feedback(FeedbackSubmission(title=' ', body='text', category='bug')))
