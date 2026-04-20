from __future__ import annotations

import re
from pathlib import Path

from browsefn.core.provider_registry import GEO_PROVIDER_IDS, IMAGE_PROVIDER_IDS, WEB_PROVIDER_IDS


def _typescript_provider_registry_source() -> str:
    repo_root = Path(__file__).resolve().parents[3]
    return (repo_root / "browsefn" / "typescript" / "src" / "core" / "provider-registry.ts").read_text()


def _parse_ids(source: str, const_name: str) -> tuple[str, ...]:
    pattern = rf"export const {const_name} = \[(.*?)\] as const"
    match = re.search(pattern, source, re.DOTALL)
    assert match, f"Unable to find {const_name} in provider-registry.ts"
    return tuple(re.findall(r"'([^']+)'", match.group(1)))


def test_canonical_provider_ids_match_typescript_contract():
    source = _typescript_provider_registry_source()

    assert WEB_PROVIDER_IDS == _parse_ids(source, "WEB_PROVIDER_IDS")
    assert IMAGE_PROVIDER_IDS == _parse_ids(source, "IMAGE_PROVIDER_IDS")
    assert GEO_PROVIDER_IDS == _parse_ids(source, "GEO_PROVIDER_IDS")
