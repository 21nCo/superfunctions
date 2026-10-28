"""Runs shared vector cases with the generated client installed in this interpreter. The package's import
name is APIFN_SDK_MODULE; fixtures are read from APIFN_SDK_FIXTURES. Shared by the pytest suite and the
cross-language vector driver."""

from __future__ import annotations

import base64
import importlib
import json
import os
import re
from pathlib import Path
from types import ModuleType
from typing import Any

MODULE = os.environ.get("APIFN_SDK_MODULE", "example_tasks_sdk")
FIXTURES = Path(os.environ.get("APIFN_SDK_FIXTURES", Path(__file__).resolve().parent.parent / "fixtures"))


def sdk() -> ModuleType:
    return importlib.import_module(MODULE)


def client_module() -> ModuleType:
    return importlib.import_module(f"{MODULE}.client")


def read_json(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text("utf-8"))


def snake_case(name: str) -> str:
    """The generator's method naming: listTasks -> list_tasks."""
    parts: list[str] = []
    for word in re.findall(r"[A-Za-z0-9]+", name):
        word = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", word)
        word = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", word)
        parts.extend(word.split(" "))
    return "_".join(part.lower() for part in parts)


def operation_name(operation_id: str) -> str:
    spec = client_module()._OPERATIONS[operation_id]
    return snake_case(spec.name)


def kwargs_for(operation_id: str, vector: dict[str, Any]) -> dict[str, Any]:
    """A generated method's keyword arguments from a vector's wire-level parameters."""
    spec = client_module()._OPERATIONS[operation_id]
    arguments: dict[str, Any] = {}
    for location, values in vector.get("parameters", {}).items():
        for name, value in values.items():
            match = next((parameter for parameter in spec.parameters if parameter.location == location and parameter.name == name), None)
            if match is None:
                raise KeyError(f"{operation_id} has no {location} parameter {name}")
            arguments[match.key] = value
    if "body" in vector:
        arguments["body"] = vector["body"]
    if "bodyBytes" in vector:
        arguments["body"] = bytes(vector["bodyBytes"])
    return arguments


def normalize(value: Any) -> Any:
    """A JSON form of a result or body that both targets can produce: bytes become {"$bytes": base64}."""
    if isinstance(value, (bytes, bytearray)):
        return {"$bytes": base64.b64encode(bytes(value)).decode("ascii")}
    return value


def outcome_of(result: Any = None, error: BaseException | None = None) -> dict[str, Any]:
    package = sdk()
    if error is None:
        return {"ok": True, "result": normalize(result)}
    if isinstance(error, TypeError):
        # Python rejects a missing required keyword argument when the method is called, before the runtime (and
        # any request or observation): the vectors' validation failure, marked so comparisons can tell.
        return {"ok": False, "kind": "validation", "attempts": 0, "rejectedAtCall": True}
    if not isinstance(error, package.ApiError):
        raise error
    outcome: dict[str, Any] = {"ok": False, "kind": error.kind, "attempts": error.attempts}
    if isinstance(error, package.ApiHttpError):
        outcome.update(status=error.status, declared=error.declared, body=normalize(error.body))
    return outcome


async def run_case(base_url: str, case: dict[str, Any], **options: Any) -> tuple[dict[str, Any], list[Any]]:
    """Calls the case's operation with a new client; returns the normalized outcome and failure observations."""
    events: list[Any] = []
    package = sdk()
    async with package.TasksClient(base_url=base_url, on_failure=events.append, **options) as client:
        method = getattr(client, operation_name(case["operation"]))
        try:
            result = await method(**kwargs_for(case["operation"], case))
        except Exception as error:  # noqa: BLE001 - normalized below
            return outcome_of(error=error), events
        return outcome_of(result), events
