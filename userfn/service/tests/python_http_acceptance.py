"""Run by the native HTTP/SQLite acceptance with the real Python SDK."""
import asyncio
import sys
from userfn import UserFnClient, UserFnOptions, FeedbackSubmission, FeedbackHTTPError


async def main():
    endpoint = sys.argv[1]
    client = UserFnClient(UserFnOptions(api_key='tenant-a-key', endpoint=endpoint, feedback_max_attempts=2))
    client.identify('python-user', {'locale': '文', 'nested': [True, None, 7]})
    submission = FeedbackSubmission(title='Python 文', body='Persist through HTTP', category='feature', tags=['python'], attachments=['https://example.test/image.png'])
    await client.submit_feedback(submission, idempotency_key='python-stable')
    await client.submit_feedback(submission, idempotency_key='python-stable')
    try:
        await client.submit_feedback(FeedbackSubmission(title='Changed', body='Different', category='bug'), idempotency_key='python-stable')
        raise AssertionError('Changed retry must fail')
    except FeedbackHTTPError as error:
        assert error.status == 409
    denied = UserFnClient(UserFnOptions(api_key='invalid', endpoint=endpoint))
    try:
        await denied.submit_feedback(submission)
        raise AssertionError('Invalid key must fail')
    except FeedbackHTTPError as error:
        assert error.status == 401
    print('Python SDK actual HTTP acceptance, duplicate, conflict and auth passed')


asyncio.run(main())
