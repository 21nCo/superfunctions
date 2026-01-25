"""Rate limiting patterns."""

import asyncio
import time
from typing import Literal
from collections import deque


Strategy = Literal['throw', 'delay', 'drop']


class RateLimiter:
    """Fixed window rate limiter."""
    
    def __init__(
        self,
        max_requests: int,
        window_ms: int,
        strategy: Strategy = 'throw'
    ):
        self.max_requests = max_requests
        self.window_ms = window_ms
        self.strategy = strategy
        self._requests: deque[int] = deque()
        self._lock = asyncio.Lock()
    
    async def acquire(self) -> bool:
        """Acquire rate limit token."""
        async with self._lock:
            now = self._now()
            window_start = now - self.window_ms
            
            # Remove old requests
            while self._requests and self._requests[0] < window_start:
                self._requests.popleft()
            
            # Check if limit exceeded
            if len(self._requests) >= self.max_requests:
                if self.strategy == 'throw':
                    raise Exception('Rate limit exceeded')
                elif self.strategy == 'drop':
                    return False
                elif self.strategy == 'delay':
                    # Wait until window resets
                    wait_time = (self._requests[0] + self.window_ms - now) / 1000.0
                    if wait_time > 0:
                        await asyncio.sleep(wait_time)
                    return await self.acquire()
            
            # Add current request
            self._requests.append(now)
            return True
    
    def _now(self) -> int:
        return int(time.time() * 1000)


class SlidingWindowRateLimiter:
    """Sliding window rate limiter."""
    
    def __init__(self, max_requests: int, window_ms: int):
        self.max_requests = max_requests
        self.window_ms = window_ms
        self._requests: deque[int] = deque()
        self._lock = asyncio.Lock()
    
    async def acquire(self) -> bool:
        """Acquire rate limit token."""
        async with self._lock:
            now = self._now()
            cutoff = now - self.window_ms
            
            # Remove expired requests
            while self._requests and self._requests[0] <= cutoff:
                self._requests.popleft()
            
            if len(self._requests) >= self.max_requests:
                return False
            
            self._requests.append(now)
            return True
    
    def _now(self) -> int:
        return int(time.time() * 1000)


class TokenBucketRateLimiter:
    """Token bucket rate limiter."""
    
    def __init__(
        self,
        capacity: int,
        refill_rate: int,
        refill_interval: int
    ):
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.refill_interval = refill_interval
        self._tokens = capacity
        self._last_refill = self._now()
        self._lock = asyncio.Lock()
    
    async def acquire(self, tokens: int = 1) -> None:
        """Acquire tokens from bucket."""
        while True:
            async with self._lock:
                self._refill()
                
                if self._tokens >= tokens:
                    self._tokens -= tokens
                    return
            
            # Wait before retry
            await asyncio.sleep(self.refill_interval / 1000.0)
    
    def _refill(self) -> None:
        """Refill tokens based on time elapsed."""
        now = self._now()
        elapsed = now - self._last_refill
        intervals = elapsed // self.refill_interval
        
        if intervals > 0:
            tokens_to_add = intervals * self.refill_rate
            self._tokens = min(self.capacity, self._tokens + tokens_to_add)
            self._last_refill += intervals * self.refill_interval
    
    def _now(self) -> int:
        return int(time.time() * 1000)
