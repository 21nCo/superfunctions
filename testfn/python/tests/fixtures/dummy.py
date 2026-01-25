def test_success():
    assert 1 + 1 == 2


def test_failure():
    assert 1 + 1 == 3


def test_skipped():
    import pytest

    pytest.skip("skipping this test")
