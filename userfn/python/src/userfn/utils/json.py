from .text import utf16_units
from typing import Any
import math

def validate_json(value: Any, ancestors=None):
    if value is None or isinstance(value, (bool, str)):
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            if math.isfinite(value):
                return
        except OverflowError:
            pass
        raise TypeError("Flag values must contain finite JSON numbers")
    if type(value) not in (dict, list):
        raise TypeError("Flag values must use plain JSON objects and arrays")
    ancestors = set() if ancestors is None else ancestors
    if id(value) in ancestors:
        raise TypeError("Flag values must be acyclic JSON values")
    ancestors.add(id(value))
    try:
        if isinstance(value, dict):
            if any(not isinstance(key, str) for key in value):
                raise TypeError("Flag object keys must be strings")
            normalized_keys = {utf16_units(key) for key in value}
            if len(normalized_keys) != len(value):
                raise TypeError("JSON object keys must be unique in UTF-16")
            values = value.values()
        else:
            values = value
        for child in values:
            validate_json(child, ancestors)
    finally:
        ancestors.remove(id(value))


def json_equal(left: Any, right: Any) -> bool:
    validate_json(left)
    validate_json(right)
    pairs = [(left, right)]
    while pairs:
        left, right = pairs.pop()
        if isinstance(left, bool) or isinstance(right, bool):
            if type(left) is not type(right) or left != right:
                return False
        elif isinstance(left, (int, float)) and isinstance(right, (int, float)):
            # Shared JSON follows JavaScript IEEE-754 numbers, not arbitrary-precision ints.
            try:
                left_number, right_number = float(left), float(right)
            except (OverflowError, ValueError):
                return False
            if not math.isfinite(left_number) or not math.isfinite(right_number) or left_number != right_number:
                return False
        elif isinstance(left, str) and isinstance(right, str):
            if utf16_units(left) != utf16_units(right):
                return False
        elif type(left) is not type(right):
            return False
        elif isinstance(left, list):
            if len(left) != len(right):
                return False
            pairs.extend(zip(left, right))
        elif isinstance(left, dict):
            left_keys = {utf16_units(key): key for key in left}
            right_keys = {utf16_units(key): key for key in right}
            if left_keys.keys() != right_keys.keys():
                return False
            pairs.extend((left[left_keys[key]], right[right_keys[key]]) for key in left_keys)
        elif left != right:
            return False
    return True


