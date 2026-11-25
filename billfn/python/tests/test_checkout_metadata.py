import pytest
from pydantic import ValidationError

from billfn.types import BillFnCheckoutCreateRequest


def test_checkout_metadata_accepts_flat_scalar_values() -> None:
    request = BillFnCheckoutCreateRequest(
        planKey="pro", provider="dodo", metadata={"campaign": "spring", "seats": 3, "ratio": 0.5, "trial": False}
    )

    assert request.metadata == {"campaign": "spring", "seats": 3, "ratio": 0.5, "trial": False}


@pytest.mark.parametrize("value", [{"name": "spring"}, ["spring"], None, float("nan"), float("inf")])
def test_checkout_metadata_refuses_nested_null_or_non_finite_values(value: object) -> None:
    with pytest.raises(ValidationError):
        BillFnCheckoutCreateRequest(planKey="pro", provider="dodo", metadata={"campaign": value})
