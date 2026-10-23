def test_success() -> None:
    assert 1 + 1 == 2


def test_failure() -> None:
    assert 1 + 1 == 3


def test_skipped() -> None:
    import pytest

    pytest.skip("skipping this test")
