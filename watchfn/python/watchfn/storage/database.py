from typing import List, Optional, Any
import asyncio
from superfunctions.db import Adapter, CreateParams
from ..models import Event

class DatabaseStorage:
    def __init__(self, db: Adapter):
        self.db = db

    def add(self, event: Event):
        # Placeholder: In a real app, this should probably queue the event
        # and a background worker running in an event loop would process it.
        pass
        
    def add_batch(self, events: List[Event]):
        # Async wrapper for batch processing
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
        loop.run_until_complete(self._add_batch_async(events))

    async def _add_batch_async(self, events: List[Event]):
        # This assumes the DB adapter supports some batch create or we loop
        for event in events:
            await self.db.create(
                CreateParams(
                    model="watch_events",
                    data=event.model_dump()
                )
            )

    def query(self, metric: Optional[str] = None) -> List[Event]:
        # Sync wrapper for query
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
        return loop.run_until_complete(self._query_async(metric))
        
    async def _query_async(self, metric: Optional[str] = None) -> List[Event]:
        # Placeholder implementation
        return []
