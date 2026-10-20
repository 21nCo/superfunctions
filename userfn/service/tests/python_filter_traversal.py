import asyncio
import hashlib
import json
import sys
from userfn import UserFnClient, UserFnOptions


def feedback_id(index):
    return 'uf_' + hashlib.sha256(json.dumps(['a', f'broad-{index}'], separators=(',', ':')).encode()).hexdigest()


async def main():
    client = UserFnClient(UserFnOptions(endpoint=sys.argv[1], api_key='read-only', feedback_max_attempts=1))
    async def traverse(**filters):
        found, after, pages, empty_progress = [], None, 0, 0
        while True:
            page = await client.get_feedback_board(limit=17, after=after, **filters)
            pages += 1
            assert pages < 200
            found.extend(item['id'] for item in page['items'])
            if not page['items'] and page['nextCursor']:
                empty_progress += 1
            if not page['nextCursor']:
                break
            assert after is None or page['nextCursor'] > after
            after = page['nextCursor']
        assert len(found) == len(set(found))
        return found, pages, empty_progress

    broad, pages, _ = await traverse(tag='broad')
    assert broad == sorted(feedback_id(i) for i in range(502))
    assert pages > 502 // 17  # Seven scanned candidates per request yields partial pages.
    sparse, _, empty = await traverse(tag='broad', product_area='sparse', status='open')
    assert sparse == sorted(feedback_id(i) for i in (0, 100, 300, 500))
    assert empty > 0
    print('Python complete filter traversal passes')


asyncio.run(main())
