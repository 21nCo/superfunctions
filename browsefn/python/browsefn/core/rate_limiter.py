"""
Rate limiter implementation for API requests
"""

import asyncio
from typing import Dict, Optional
from datetime import datetime
from browsefn.core.types import RateLimitConfig, RateLimitStatus


class RateLimitEntry:
    """Single rate limit tracking entry"""
    
    def __init__(self):
        self.count = 0
        self.window_start = 0.0


class RateLimiter:
    """Rate limiter with sliding window algorithm"""
    
    def __init__(
        self,
        global_config: Optional[RateLimitConfig] = None,
        per_provider_configs: Optional[Dict[str, RateLimitConfig]] = None
    ):
        self.global_config = global_config
        self.configs: Dict[str, RateLimitConfig] = per_provider_configs or {}
        self.limits: Dict[str, RateLimitEntry] = {}
    
    async def check_limit(self, provider: str) -> bool:
        """Check if a request is allowed for the given provider"""
        config = self.configs.get(provider) or self.global_config
        if not config:
            return True
        
        now = datetime.now().timestamp() * 1000  # milliseconds
        entry = self.limits.get(provider)
        
        if not entry:
            entry = RateLimitEntry()
            entry.count = 1
            entry.window_start = now
            self.limits[provider] = entry
            return True
        
        # Check if window has expired
        if now - entry.window_start >= config.window:
            entry.count = 1
            entry.window_start = now
            return True
        
        # Check if under limit
        if entry.count < config.requests:
            entry.count += 1
            return True
        
        return False
    
    async def wait_for_limit(self, provider: str) -> None:
        """Wait until rate limit allows the request"""
        config = self.configs.get(provider) or self.global_config
        if not config:
            return
        
        while not await self.check_limit(provider):
            status = self.get_status(provider)
            wait_time = status.reset_at - (datetime.now().timestamp() * 1000)
            if wait_time > 0:
                # Wait for minimum of remaining time or 1 second
                await asyncio.sleep(min(wait_time / 1000, 1.0))
    
    def get_status(self, provider: str) -> RateLimitStatus:
        """Get rate limit status for a provider"""
        config = self.configs.get(provider) or self.global_config
        if not config:
            return RateLimitStatus(
                remaining=float('inf'),
                reset_at=0,
                limit=float('inf')
            )
        
        entry = self.limits.get(provider)
        now = datetime.now().timestamp() * 1000
        
        if not entry:
            return RateLimitStatus(
                remaining=config.requests,
                reset_at=now + config.window,
                limit=config.requests
            )
        
        window_end = entry.window_start + config.window
        
        if now >= window_end:
            return RateLimitStatus(
                remaining=config.requests,
                reset_at=now + config.window,
                limit=config.requests
            )
        
        return RateLimitStatus(
            remaining=max(0, config.requests - entry.count),
            reset_at=window_end,
            limit=config.requests
        )
    
    def reset(self, provider: Optional[str] = None) -> None:
        """Reset rate limit for a provider or all providers"""
        if provider:
            if provider in self.limits:
                del self.limits[provider]
        else:
            self.limits.clear()
    
    def set_config(self, provider: str, config: RateLimitConfig) -> None:
        """Set rate limit config for a provider"""
        self.configs[provider] = config
