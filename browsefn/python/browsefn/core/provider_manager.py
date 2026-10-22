from datetime import datetime
from typing import Any, Awaitable, Callable, Dict, Generic, List, Optional, Tuple, TypeVar

from browsefn.core.errors import BrowseFnError, normalize_provider_error

T = TypeVar("T")


class AvailabilityCache:
    """Cache provider availability checks for a short TTL."""

    def __init__(self, ttl: int = 60000):
        self.ttl = ttl
        self.cache: Dict[str, Tuple[bool, float]] = {}

    def get(self, name: str) -> Optional[bool]:
        if name not in self.cache:
            return None

        available, timestamp = self.cache[name]
        now = datetime.now().timestamp() * 1000

        if now - timestamp < self.ttl:
            return available

        del self.cache[name]
        return None

    def set(self, name: str, available: bool) -> None:
        self.cache[name] = (available, datetime.now().timestamp() * 1000)

    def clear(self) -> None:
        self.cache.clear()


class ProviderManager(Generic[T]):
    """Manage providers, availability, and deterministic fallback order."""

    AVAILABILITY_CACHE_TTL = 60000

    def __init__(
        self,
        providers: Dict[str, T],
        default_provider: Optional[str] = None,
        fallback_chain: Optional[List[str]] = None,
        fallback_on_errors: Optional[List[str]] = None,
    ):
        self.providers = providers
        self.default_provider = default_provider
        self.fallback_chain = fallback_chain or []
        self.fallback_on_errors = fallback_on_errors
        self.availability_cache = AvailabilityCache(self.AVAILABILITY_CACHE_TTL)

    def get_provider(self, name: Optional[str] = None) -> T:
        provider_name = name or self.default_provider
        if not provider_name:
            if not self.providers:
                raise BrowseFnError(
                    "PROVIDER_UNAVAILABLE",
                    "No providers are registered.",
                )
            provider_name = next(iter(self.providers))

        provider = self.providers.get(provider_name)
        if provider is None:
            raise BrowseFnError(
                "UNSUPPORTED_PROVIDER",
                f"Provider {provider_name} is not supported.",
                provider=provider_name,
            )

        return provider

    def register_provider(self, name: str, provider: T) -> None:
        self.providers[name] = provider
        self.availability_cache.clear()

    def set_default_provider(self, name: str) -> None:
        if name not in self.providers:
            raise BrowseFnError(
                "UNSUPPORTED_PROVIDER",
                f"Provider {name} is not supported.",
                provider=name,
            )
        self.default_provider = name

    async def is_available(self, name: str) -> bool:
        provider = self.providers.get(name)
        if provider is None:
            return False

        cached = self.availability_cache.get(name)
        if cached is not None:
            return cached

        try:
            available = await provider.is_available()
        except Exception:
            available = False

        self.availability_cache.set(name, available)
        return available

    def get_fallback_chain(self, requested_provider: Optional[str] = None) -> List[str]:
        chain: List[str] = []

        if requested_provider and requested_provider in self.providers:
            chain.append(requested_provider)

        if self.default_provider and self.default_provider not in chain:
            chain.append(self.default_provider)

        for provider in self.fallback_chain:
            if provider not in chain and provider in self.providers:
                chain.append(provider)

        for provider in sorted(self.providers.keys()):
            if provider not in chain:
                chain.append(provider)

        return chain

    async def execute_with_fallback(
        self,
        requested_provider: Optional[str],
        executor: Callable[[T, str], Awaitable[Any]],
        on_fallback: Optional[Callable[[str, str, Exception], None]] = None,
        before_provider: Optional[Callable[[T], None]] = None,
    ) -> Any:
        chain = self.get_fallback_chain(requested_provider)
        if not chain:
            raise BrowseFnError(
                "PROVIDER_UNAVAILABLE",
                "No providers are available for execution.",
                provider=requested_provider,
            )

        errors: List[Tuple[str, Exception]] = []

        for index, provider_name in enumerate(chain):
            provider = self.providers.get(provider_name)
            if provider is None:
                continue

            if before_provider is not None:
                before_provider(provider)
            if not await self.is_available(provider_name):
                error = BrowseFnError(
                    "PROVIDER_UNAVAILABLE",
                    f"Provider {provider_name} is not available.",
                    provider=provider_name,
                )
                self._assert_fallback_allowed(error)
                errors.append((provider_name, error))
                if index < len(chain) - 1 and on_fallback:
                    on_fallback(provider_name, chain[index + 1], error)
                continue

            try:
                return await executor(provider, provider_name)
            except Exception as error:
                error = normalize_provider_error(error, provider_name)
                self._assert_fallback_allowed(error)
                errors.append((provider_name, error))
                if index < len(chain) - 1 and on_fallback:
                    on_fallback(provider_name, chain[index + 1], error)

        raise self._summarize_errors(errors)

    def _assert_fallback_allowed(self, error: BrowseFnError) -> None:
        if error.code == "SECURITY_POLICY_BLOCKED":
            raise error
        aliases = {"RATE_LIMIT": "RATE_LIMITED", "TIMEOUT": "UPSTREAM_TIMEOUT", "NOT_FOUND": "UPSTREAM_NOT_FOUND"}
        if self.fallback_on_errors is not None and error.code not in [aliases.get(code, code) for code in self.fallback_on_errors]:
            raise error

    def _summarize_errors(self, errors: List[Tuple[str, Exception]]) -> BrowseFnError:
        if not errors:
            return BrowseFnError("PROVIDER_UNAVAILABLE", "No providers are available.")

        last_provider, last_error = errors[-1]
        if isinstance(last_error, BrowseFnError):
            if last_error.code == "UPSTREAM_TIMEOUT":
                return BrowseFnError(
                    "UPSTREAM_TIMEOUT",
                    f"Provider {last_provider} timed out after configured retries.",
                    provider=last_provider,
                )
            return last_error

        return BrowseFnError(
            "PROVIDER_ERROR",
            str(last_error),
            provider=last_provider,
        )

    def list(self) -> List[str]:
        return sorted(self.providers.keys())

    async def list_available(self) -> List[str]:
        available = []
        for name in sorted(self.providers.keys()):
            if await self.is_available(name):
                available.append(name)
        return available

    def clear_availability_cache(self) -> None:
        self.availability_cache.clear()
