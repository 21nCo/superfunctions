import asyncio
import sys
from userfn import UserFnClient, UserFnOptions, FeedbackHTTPError, FeedbackSubmission

async def main():
    endpoint, feedback_id = sys.argv[1:]
    client = UserFnClient(UserFnOptions(endpoint=endpoint, api_key='python-voter', feedback_max_attempts=1))
    await client.submit_feedback(FeedbackSubmission(title='Python filter', body='Stored tags', category='feature', tags=['Python', ' Python '], product_area=' SDK '), idempotency_key='python-filter')
    filtered = await client.get_feedback_board(tag='Python', product_area='SDK', status='open')
    assert len(filtered['items']) == 1 and filtered['items'][0]['productArea'] == 'SDK'
    page = await client.get_feedback_board(limit=1)
    assert len(page['items']) == 1
    for direction in (1, -1, 0):
        assert (await client.vote_feedback(feedback_id, direction))['viewerVote'] == direction
    assert (await client.set_feedback_status(feedback_id, 'planned'))['status'] == 'planned'
    page = await client.get_feedback_board(status='planned')
    assert [item['id'] for item in page['items']] == [feedback_id]
    denied = UserFnClient(UserFnOptions(endpoint=endpoint, api_key='read-only', feedback_max_attempts=1))
    for name, value in [('vote_feedback', 1), ('set_feedback_status', 'done')]:
        try:
            await getattr(denied, name)(feedback_id, value)
            raise AssertionError('Expected forbidden')
        except FeedbackHTTPError as error:
            assert error.status == 403
    print('Python board HTTP acceptance passes')

asyncio.run(main())
