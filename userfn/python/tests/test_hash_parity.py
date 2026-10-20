import json
from pathlib import Path
import pytest
from userfn.utils.hash import fnv1a_hash, get_bucket

VECTORS = json.loads((Path(__file__).parent / 'fixtures' / 'hash-vectors.json').read_text())

@pytest.mark.parametrize('vector', VECTORS)
def test_javascript_utf16_rollout_vectors(vector):
    assert fnv1a_hash(vector['key'] + ':' + vector['userId']) == vector['hash']
    assert get_bucket(vector['key'], vector['userId']) == vector['bucket']
