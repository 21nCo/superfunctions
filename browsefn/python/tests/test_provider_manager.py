"""
Tests for provider manager
"""

import pytest
from browsefn.core.provider_manager import ProviderManager


class MockProvider:
    def __init__(self, name: str, available: bool = True):
        self.name = name
        self._available = available
    
    async def is_available(self):
        return self._available


@pytest.mark.asyncio
async def test_provider_manager_get():
    """Test getting providers"""
    providers = {
        'provider1': MockProvider('provider1'),
        'provider2': MockProvider('provider2')
    }
    manager = ProviderManager(providers, default_provider='provider1')
    
    provider = manager.get_provider()
    assert provider.name == 'provider1'
    
    provider = manager.get_provider('provider2')
    assert provider.name == 'provider2'


@pytest.mark.asyncio
async def test_provider_manager_fallback_chain():
    """Test fallback chain construction"""
    providers = {
        'p1': MockProvider('p1'),
        'p2': MockProvider('p2'),
        'p3': MockProvider('p3')
    }
    manager = ProviderManager(
        providers,
        default_provider='p1',
        fallback_chain=['p2', 'p3']
    )
    
    # Request p3, should get chain: p3 -> p1 -> p2
    chain = manager.get_fallback_chain('p3')
    assert chain == ['p3', 'p1', 'p2']
    
    # Request unknown, should get chain: p1 -> p2 -> p3
    chain = manager.get_fallback_chain('unknown')
    assert chain[0] == 'p1'


@pytest.mark.asyncio
async def test_provider_manager_availability():
    """Test provider availability checking"""
    providers = {
        'available': MockProvider('available', available=True),
        'unavailable': MockProvider('unavailable', available=False)
    }
    manager = ProviderManager(providers)
    
    assert await manager.is_available('available') == True
    assert await manager.is_available('unavailable') == False


@pytest.mark.asyncio
async def test_provider_manager_execute_with_fallback():
    """Test executing with fallback"""
    providers = {
        'failing': MockProvider('failing', available=False),
        'working': MockProvider('working', available=True)
    }
    manager = ProviderManager(
        providers,
        default_provider='failing',
        fallback_chain=['working']
    )
    
    async def executor(provider, name):
        if provider.name == 'failing':
            raise Exception('Provider failed')
        return f'Success from {name}'
    
    result = await manager.execute_with_fallback('failing', executor)
    assert result == 'Success from working'


@pytest.mark.asyncio
async def test_provider_manager_list_available():
    """Test listing available providers"""
    providers = {
        'p1': MockProvider('p1', available=True),
        'p2': MockProvider('p2', available=False),
        'p3': MockProvider('p3', available=True)
    }
    manager = ProviderManager(providers)
    
    available = await manager.list_available()
    assert set(available) == {'p1', 'p3'}


@pytest.mark.asyncio
async def test_provider_manager_register():
    """Test provider registration"""
    manager = ProviderManager({})
    
    provider = MockProvider('test')
    manager.register_provider('test', provider)
    
    assert 'test' in manager.list()
    assert manager.get_provider('test') == provider
