"""Webhook notification channel."""

from typing import Dict, Any, Optional
import httpx
import asyncio


class WebhookChannel:
    """Send notifications to webhook."""
    
    def __init__(
        self,
        url: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: int = 10,
        retries: int = 3
    ):
        self.url = url
        self.headers = headers or {}
        self.timeout = timeout
        self.retries = retries
    
    async def send(self, payload: Dict[str, Any]) -> None:
        """Send notification to webhook."""
        last_error = None
        
        for attempt in range(self.retries):
            try:
                await self._send_request(payload)
                return  # Success
            except Exception as e:
                last_error = e
                if attempt < self.retries - 1:
                    await asyncio.sleep(2 ** attempt)  # Exponential backoff
        
        raise last_error or Exception("Webhook send failed")
    
    async def _send_request(self, payload: Dict[str, Any]) -> None:
        """Send HTTP request."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                self.url,
                json=payload,
                headers={**self.headers, "Content-Type": "application/json"}
            )
            
            if response.status_code >= 400:
                raise Exception(f"Webhook failed: {response.status_code} {response.text}")
