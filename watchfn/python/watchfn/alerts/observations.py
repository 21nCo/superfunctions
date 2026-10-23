"""Bounded stored-event observations and windowed alert evaluation.

Epoch milliseconds match the TypeScript condition contract. This module does
not persist alert definitions or deliver notifications.
"""
import math
import re
import sys
from ..query import field, number, read, timestamp, sequential_sum


def window_ms(value):
    match = re.fullmatch(r"(\d+(?:\.\d+)?)(ms|s|m|h|d)", value) if isinstance(value, str) else None
    result = float(match[1]) * {"ms": 1, "s": 1000, "m": 60000, "h": 3600000, "d": 86400000}[match[2]] if match else 0
    if not number(result) or result <= 0 or result > 9007199254740991 or not result.is_integer():
        raise ValueError("Alert window must be a positive finite duration")
    return result


def validate(condition):
    nodes = 0
    def visit(rule, depth):
        nonlocal nodes
        nodes += 1
        if not isinstance(rule, dict) or nodes > 128 or depth > 16:
            raise ValueError("Invalid or excessively nested alert condition")
        kind = rule.get("type", "threshold")
        if kind == "composite":
            if rule.get("operator") not in ("and", "or") or not isinstance(rule.get("conditions"), list) or not rule["conditions"]:
                raise ValueError("Composite alerts require an operator and conditions")
            for child in rule["conditions"]: visit(child, depth + 1)
            return
        metric = field(rule.get("metric"))
        if len(metric) > 255: raise ValueError("Alert metric is too long")
        if kind == "anomaly":
            minimum = rule.get("minDataPoints", rule.get("min_data_points"))
            if (not number(rule.get("sensitivity")) or not 0 <= rule["sensitivity"] <= 1
                    or type(minimum) is not int or not 2 <= minimum <= 9007199254740991
                    or rule.get("algorithm") not in ("moving-average", "stddev")):
                raise ValueError("Invalid anomaly condition")
        elif kind == "threshold":
            if (not number(rule.get("threshold")) or rule.get("operator") not in ("gt", "gte", "lt", "lte", "eq", "ne")
                    or rule.get("aggregation", "avg") not in ("avg", "sum", "min", "max", "count")):
                raise ValueError("Invalid threshold condition")
            window_ms(rule.get("window"))
        else: raise ValueError("Unsupported alert condition")
    visit(condition, 0)


def observations(events, metric, start, now, maximum):
    field(metric)
    if not number(now) or (start is not None and (not number(start) or start > now)):
        raise ValueError("Invalid observation range")
    if type(maximum) is not int or not 1 <= maximum <= 1000000:
        raise ValueError("Observation capacity must be 1..1000000")
    # Exact presence is selected within the requested window, as in TS alerts
    # (scalar aggregate fallback deliberately has a different presence scope).
    rows = [event.model_dump() for event in events]
    rows = [row for row in rows if timestamp(row["timestamp"]) <= now and (start is None or timestamp(row["timestamp"]) >= start)]
    exact = any(row.get("name") == metric or row["type"] == metric for row in rows)
    base, _, suffix = metric.rpartition(".")
    selected = metric if exact else base
    result = []
    for row in rows:
        if not selected or (row.get("name") != selected and row["type"] != selected): continue
        value = read(row, "value" if exact else suffix)
        if not number(value): continue
        if len(result) >= maximum: raise ValueError("Alert observation capacity exceeded; window was not evaluated")
        result.append({"value": float(value), "timestamp": timestamp(row["timestamp"])})
    return result


def evaluate(condition, data, now):
    """Return True/False/None; None is an unknown observation, never recovery."""
    validate(condition)
    if not number(now): raise ValueError("Evaluation time must be finite")
    def visit(rule):
        kind = rule.get("type", "threshold")
        if kind == "composite":
            matches = [visit(child) for child in rule["conditions"]]
            decisive = False if rule["operator"] == "and" else True
            return decisive if any(value is decisive for value in matches) else None if None in matches else not decisive
        cutoff = -math.inf if kind == "anomaly" else now - window_ms(rule["window"])
        points = [point for point in data.get(rule["metric"], []) if number(point.get("value")) and number(point.get("timestamp")) and cutoff <= point["timestamp"] <= now]
        if not points: return None
        values = [point["value"] for point in points]
        if kind == "anomaly":
            if len(points) < rule.get("minDataPoints", rule.get("min_data_points")): return None
            points.sort(key=lambda point: point["timestamp"])
            history = [point["value"] for point in points[:-1]]
            current = points[-1]["value"]
            mean = sequential_sum(value / len(history) for value in history)
            delta = abs(current - mean)
            if not number(mean) or not number(delta): return None
            if delta <= sys.float_info.epsilon * max(abs(value) for value in values) * 8: return False
            if rule["algorithm"] == "moving-average": return delta > 0 if mean == 0 else delta / abs(mean) > 1 - rule["sensitivity"]
            try: variance = sequential_sum((value - mean) ** 2 / len(history) for value in history)
            except OverflowError: return None
            if not number(variance): return None
            return delta > 0 if variance == 0 else delta / math.sqrt(variance) > 3 - rule["sensitivity"] * 2
        aggregation = rule.get("aggregation", "avg")
        if aggregation == "avg": value = sequential_sum(value / len(values) for value in values)
        elif aggregation == "sum": value = sequential_sum(values)
        elif aggregation == "min": value = min(values)
        elif aggregation == "max": value = max(values)
        else: value = len(values)
        if not number(value): return None
        target = rule["threshold"]
        return {"gt": value > target, "gte": value >= target, "lt": value < target, "lte": value <= target, "eq": value == target, "ne": value != target}[rule["operator"]]
    return visit(condition)


def ranges(condition, now, result):
    if condition.get("type") == "composite":
        for child in condition["conditions"]: ranges(child, now, result)
        return
    metric = condition["metric"]
    start = None if condition.get("type") == "anomaly" else now - window_ms(condition["window"])
    if metric not in result: result[metric] = start
    elif start is None or result[metric] is None: result[metric] = None
    else: result[metric] = min(start, result[metric])
