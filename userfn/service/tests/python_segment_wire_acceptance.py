"""Evaluate the shared targeting vectors through real signed HTTP refresh."""
import asyncio
import json
import sys
from pathlib import Path
from userfn import UserFnClient, UserFnOptions, SignedConfigOptions

async def main():
    vectors=json.loads(Path(sys.argv[3]).read_text())
    client=UserFnClient(UserFnOptions(api_key='reader-a',endpoint=sys.argv[1],environment='segments',
        config=SignedConfigOptions(tenant_id='a',trusted_keys={'key-1':sys.argv[2]},allow_insecure_http=True)))
    assert await client.refresh_config() is True
    for index,vector in enumerate(vectors):
        client.identify('fixture',vector['traits'])
        assert client.get_flag('case-'+str(index),False) is vector['expected'],vector['id']
    for case_id, native in [('equal-unicode','\ud83d\ude00'),('equal-unicode-key',{'\ud83d\ude00':True})]:
        index=next(index for index,vector in enumerate(vectors) if vector['id']==case_id)
        client.identify('fixture',{'subject':native})
        assert client.get_flag('case-'+str(index),False) is True
    assert await client.refresh_config() is False
    client.close_config()
    print('Python signed configuration segment semantics match shared vectors')

asyncio.run(main())
