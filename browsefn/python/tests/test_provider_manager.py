"""Tests for the Python provider manager."""

from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from browsefn.core.errors import BrowseFnError
from browsefn.core.provider_manager import ProviderManager


class MockProvider:
    def __init__(self, name: str, available: bool = True):
        self.name = name
        self._available = available

    async def is_available(self):
        return self._available


def test_provider_manager_gets_default_provider_and_sorts_ids():
    providers = {
        "provider2": MockProvider("provider2"),
        "provider1": MockProvider("provider1"),
    }
    manager = ProviderManager(providers, default_provider="provider1")

    assert manager.get_provider().name == "provider1"
    assert manager.get_provider("provider2").name == "provider2"
    assert manager.list() == ["provider1", "provider2"]


def test_provider_manager_raises_canonical_unknown_provider_error():
    manager = ProviderManager({})

    with pytest.raises(BrowseFnError, match="No providers are registered."):
        manager.get_provider()


@pytest.mark.asyncio
async def test_provider_manager_builds_fallback_chain_and_executes_next_provider():
    providers = {
        "firecrawl": MockProvider("firecrawl", available=False),
        "cheerio": MockProvider("cheerio", available=True),
        "jina": MockProvider("jina", available=True),
    }
    manager = ProviderManager(
        providers,
        default_provider="firecrawl",
        fallback_chain=["cheerio", "jina"],
    )
    fallbacks = []

    async def executor(provider, name):
        return f"success:{name}"

    result = await manager.execute_with_fallback(
        "firecrawl",
        executor,
        on_fallback=lambda current, nxt, err: fallbacks.append((current, nxt, str(err))),
    )

    assert manager.get_fallback_chain("firecrawl") == ["firecrawl", "cheerio", "jina"]
    assert result == "success:cheerio"
    assert fallbacks[0][0] == "firecrawl"
    assert fallbacks[0][1] == "cheerio"


@pytest.mark.asyncio
async def test_provider_manager_returns_structured_timeout_error_when_all_fail():
    providers = {"firecrawl": MockProvider("firecrawl", available=True)}
    manager = ProviderManager(providers, default_provider="firecrawl")

    async def executor(provider, name):
        raise BrowseFnError("UPSTREAM_TIMEOUT", "gateway timeout", provider=name)

    with pytest.raises(BrowseFnError, match="Provider firecrawl timed out after configured retries."):
        await manager.execute_with_fallback("firecrawl", executor)


@pytest.mark.asyncio
async def test_provider_manager_lists_available_providers_only():
    providers = {
        "p1": MockProvider("p1", available=True),
        "p2": MockProvider("p2", available=False),
        "p3": MockProvider("p3", available=True),
    }
    manager = ProviderManager(providers)

    assert await manager.list_available() == ["p1", "p3"]
