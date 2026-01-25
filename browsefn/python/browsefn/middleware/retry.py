"""
Retry middleware for handling request retries
"""

import asyncio
from typing import Callable, Awaitable, TypeVar, Optional, Dict, Any
from browsefn.core.types import RetryConfig

T = TypeVar('T')


class RetryMiddleware:
    """Middleware for executing functions with retry logic"""
    
    def __init__(self, config: RetryConfig):
        self.config = config
    
    async def execute(
        self,
        fn: Callable[[], Awaitable[T]],
        context: Optional[Dict[str, Any]] = None
    ) -> T:
        """Execute function with retry logic"""
        if not self.config.enabled:
            return await fn()
        
        last_error: Optional[Exception] = None
        max_attempts = self.config.max_attempts
        
        for attempt in range(1, max_attempts + 1):
            try:
                return await fn()
            except Exception as error:
                last_error = error
                
                # Check if error is retryable
                if self.config.retry_on:
                    error_code = getattr(error, 'code', None) or getattr(error, 'status_code', None)
                    if error_code and error_code not in self.config.retry_on:
                        raise error
                
                # Don't retry on last attempt
                if attempt == max_attempts:
                    break
                
                # Call retry callback if provided
                # Note: callback is omitted in types since it's a function
                
                # Calculate delay
                delay = self._calculate_delay(attempt)
                await asyncio.sleep(delay / 1000)  # Convert ms to seconds
        
        raise last_error or Exception('Max retry attempts reached')
    
    def _calculate_delay(self, attempt: int) -> float:
        """Calculate delay based on backoff strategy"""
        base_delay = self.config.delay
        
        if self.config.backoff == 'exponential':
            return base_delay * (2 ** (attempt - 1))
        
        return base_delay * attempt
