"""Actual Python SDK verification and conditional refresh against the running service."""
import asyncio
import sys
from userfn import UserFnClient, UserFnOptions, SignedConfigOptions

async def main():
    client = UserFnClient(UserFnOptions(api_key='reader-a', endpoint=sys.argv[1], environment='python',
        bootstrap_flags={'enabled': 'bootstrap'}, config=SignedConfigOptions(tenant_id='a', trusted_keys={'key-1': sys.argv[2]}, allow_insecure_http=True)))
    assert client.get_flag('enabled') == 'bootstrap'
    assert await client.refresh_config() is True
    assert client.get_flag('enabled', 'fallback') == {'nested': [False, 0, '文']}
    assert await client.refresh_config() is False
    client.set_segments([])
    assert await client.refresh_config() is True
    client.close_config()
    print('Python SDK verifies actual signed HTTP configuration and conditional refresh')

asyncio.run(main())
