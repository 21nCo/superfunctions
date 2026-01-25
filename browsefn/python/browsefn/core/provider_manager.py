from typing import Dict, Generic, TypeVar, Optional, List, Callable, Awaitable, Any
from datetime import datetime
from browsefn.core.types import ProviderConfig, WebProvider, ImageProvider, GeoProvider

T = TypeVar('T')


class AvailabilityCache:
    """Cache for provider availability checks"""
    
    def __init__(self, ttl: int = 60000):
        self.ttl = ttl  # milliseconds
        self.cache: Dict[str, tuple[bool, float]] = {}
    
    def get(self, name: str) -> Optional[bool]:
        """Get cached availability if not expired"""
        if name not in self.cache:
            return None
        
        available, timestamp = self.cache[name]
        now = datetime.now().timestamp() * 1000
        
        if now - timestamp < self.ttl:
            return available
        
        # Expired
        del self.cache[name]
        return None
    
    def set(self, name: str, available: bool) -> None:
        """Cache availability result"""
        timestamp = datetime.now().timestamp() * 1000
        self.cache[name] = (available, timestamp)
    
    def clear(self) -> None:
        """Clear all cached availability"""
        self.cache.clear()


class ProviderManager(Generic[T]):
    """Manager for orchestrating providers with fallback support"""
    
    AVAILABILITY_CACHE_TTL = 60000  # 1 minute
    
    def __init__(
        self,
        providers: Dict[str, T],
        default_provider: Optional[str] = None,
        fallback_chain: Optional[List[str]] = None
    ):
        self.providers = providers
        self.default_provider = default_provider
        self.fallback_chain = fallback_chain or []
        self.availability_cache = AvailabilityCache(self.AVAILABILITY_CACHE_TTL)

    def get_provider(self, name: Optional[str] = None) -> T:
        """Get provider by name or return default"""
        provider_name = name or self.default_provider
        if not provider_name:
            if not self.providers:
                raise ValueError("No providers available")
            provider_name = next(iter(self.providers))
        
        provider = self.providers.get(provider_name)
        if not provider:
            raise ValueError(f"Provider '{provider_name}' not found")
            
        return provider

    def register_provider(self, name: str, provider: T):
        """Register a new provider"""
        self.providers[name] = provider

    def set_default_provider(self, name: str):
        """Set the default provider"""
        if name not in self.providers:
            raise ValueError(f"Provider '{name}' not found")
        self.default_provider = name
    
    async def is_available(self, name: str) -> bool:
        """Check if provider is available (with caching)"""
        provider = self.providers.get(name)
        if not provider:
            return False
        
        # Check cache first
        cached = self.availability_cache.get(name)
        if cached is not None:
            return cached
        
        # Check availability
        try:
            available = await provider.is_available()
            self.availability_cache.set(name, available)
            return available
        except Exception:
            self.availability_cache.set(name, False)
            return False
    
    def get_fallback_chain(self, requested_provider: Optional[str] = None) -> List[str]:
        """Get fallback chain with requested provider first"""
        chain: List[str] = []
        
        # Add requested provider first
        if requested_provider and requested_provider in self.providers:
            chain.append(requested_provider)
        
        # Add default provider if not already in chain
        if self.default_provider and self.default_provider not in chain:
            chain.append(self.default_provider)
        
        # Add fallback chain
        for provider in self.fallback_chain:
            if provider not in chain and provider in self.providers:
                chain.append(provider)
        
        # Add any remaining providers
        for provider in self.providers.keys():
            if provider not in chain:
                chain.append(provider)
        
        return chain
    
    async def execute_with_fallback(
        self,
        requested_provider: Optional[str],
        executor: Callable[[T, str], Awaitable[Any]],
        on_fallback: Optional[Callable[[str, str, Exception], None]] = None
    ) -> Any:
        """Execute with fallback to other providers on failure"""
        chain = self.get_fallback_chain(requested_provider)
        errors: List[tuple[str, Exception]] = []
        
        for i, provider_name in enumerate(chain):
            provider = self.providers.get(provider_name)
            if not provider:
                continue
            
            # Check availability
            available = await self.is_available(provider_name)
            if not available:
                error = Exception(f"Provider {provider_name} is not available")
                errors.append((provider_name, error))
                continue
            
            try:
                result = await executor(provider, provider_name)
                return result
            except Exception as error:
                errors.append((provider_name, error))
                
                # Notify fallback if not the last provider
                if i < len(chain) - 1 and on_fallback:
                    on_fallback(provider_name, chain[i + 1], error)
        
        # All providers failed
        error_messages = [f"{name}: {str(err)}" for name, err in errors]
        raise Exception(f"All providers failed: {'; '.join(error_messages)}")
    
    def list(self) -> List[str]:
        """List all registered providers"""
        return list(self.providers.keys())
    
    async def list_available(self) -> List[str]:
        """List all available providers"""
        available = []
        for name in self.providers.keys():
            if await self.is_available(name):
                available.append(name)
        return available
    
    def clear_availability_cache(self) -> None:
        """Clear availability cache"""
        self.availability_cache.clear()
