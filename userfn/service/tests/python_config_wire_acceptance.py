"""Wire interoperability fixture, not an SDK transport or signature verifier."""
import json
import sys
import urllib.request
from userfn.client import UserFnClient
from userfn.types import UserFnOptions, FlagConfig, FlagPrerequisite, FlagEnvironmentOverride

request = urllib.request.Request(sys.argv[1] + '/config/python', headers={'Authorization': 'Bearer reader-a'})
with urllib.request.urlopen(request) as response:
    snapshot = json.load(response)
assert snapshot['version'] == 1 and snapshot['environment'] == 'python' and snapshot['tenantId'] == 'a'
client = UserFnClient(UserFnOptions(api_key='unused', environment='python'))
# Explicit wire mapping for the fixture's supported fields. Production SDK fetching/verification
# remains a separate requirement and must authenticate the exact bytes before loading them.
flags = []
for flag in snapshot['flags']:
    assert flag['rules'] == [] and flag['variations'] == []
    flags.append(FlagConfig(
        key=flag['key'], enabled=flag['enabled'], default_value=flag['defaultValue'], rules=[], variations=[],
        prerequisites=[FlagPrerequisite(key=entry['key'], expected_value=entry['expectedValue']) for entry in flag.get('prerequisites', [])],
        environment_overrides={key: FlagEnvironmentOverride(default_value=value['defaultValue']) for key, value in flag.get('environmentOverrides', {}).items()},
    ))
client.set_flags(flags)
assert client.get_flag('enabled', 'fallback') == {'nested': [False, 0, '文']}
print('Python SDK evaluates actual HTTP wire configuration through explicit fixture mapping')
