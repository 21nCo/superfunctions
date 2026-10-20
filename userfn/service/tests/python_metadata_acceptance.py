import asyncio
import sys
from userfn import UserFnClient, UserFnOptions, FeedbackHTTPError

async def main():
    endpoint, feedback_id = sys.argv[1:]
    client = UserFnClient(UserFnOptions(endpoint=endpoint, api_key='python-moderator', feedback_max_attempts=1))
    assert await client.set_feedback_metadata(feedback_id, {'tags': [' Python ', 'Python'], 'productArea': ' SDK '}) == {'id': feedback_id, 'tags': ['Python'], 'productArea': 'SDK'}
    assert (await client.get_feedback_board(tag='Python', product_area='SDK'))['items'][0]['id'] == feedback_id
    assert await client.set_feedback_metadata(feedback_id, {'tags': []}) == {'id': feedback_id, 'tags': [], 'productArea': 'SDK'}
    assert (await client.get_feedback_board(tag='Python'))['items'] == []
    assert (await client.set_feedback_metadata(feedback_id, {'productArea': None}))['productArea'] is None
    for key, expected in [('read-only', 403), ('tenant-b', 404)]:
        denied = UserFnClient(UserFnOptions(endpoint=endpoint, api_key=key, feedback_max_attempts=1))
        try:
            await denied.set_feedback_metadata(feedback_id, {'tags': ['spoof']})
            raise AssertionError('Expected rejection')
        except FeedbackHTTPError as error:
            assert error.status == expected
    await client.set_feedback_metadata(feedback_id, {'tags': ['Python'], 'productArea': 'SDK'})
    print('Python metadata HTTP acceptance passes')

asyncio.run(main())
