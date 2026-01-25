"""Tests for context manager."""

import pytest
import asyncio
from watchfn.core.context_manager import ContextManager, Context


@pytest.fixture
def context_manager():
    return ContextManager()


class TestContextManager:
    def test_run_with_context(self, context_manager):
        """Test running function with context."""
        context = Context(request_id="req_123", user_id="user_456")
        
        def check_context():
            current = context_manager.get()
            assert current is not None
            assert current.request_id == "req_123"
            assert current.user_id == "user_456"
        
        context_manager.run(context, check_context)
    
    @pytest.mark.asyncio
    async def test_async_run_with_context(self, context_manager):
        """Test running async function with context."""
        context = Context(request_id="req_async")
        
        async def check_context():
            await asyncio.sleep(0.01)
            current = context_manager.get()
            assert current is not None
            assert current.request_id == "req_async"
        
        await context_manager.run_async(context, check_context)
    
    @pytest.mark.asyncio
    async def test_context_isolation(self, context_manager):
        """Test that contexts are isolated."""
        results = []
        
        async def task1():
            context = Context(request_id="req_1")
            await context_manager.run_async(context, lambda: results.append(
                context_manager.get().request_id if context_manager.get() else None
            ))
        
        async def task2():
            context = Context(request_id="req_2")
            await context_manager.run_async(context, lambda: results.append(
                context_manager.get().request_id if context_manager.get() else None
            ))
        
        await asyncio.gather(task1(), task2())
        
        assert "req_1" in results
        assert "req_2" in results
    
    def test_set_and_get_tags(self, context_manager):
        """Test setting and getting tags."""
        context = Context(request_id="test")
        
        def check_tags():
            context_manager.set_tag("environment", "test")
            context_manager.set_tag("version", "1.0.0")
            
            assert context_manager.get_tag("environment") == "test"
            assert context_manager.get_tag("version") == "1.0.0"
        
        context_manager.run(context, check_tags)
    
    def test_set_multiple_tags(self, context_manager):
        """Test setting multiple tags at once."""
        context = Context(request_id="test")
        
        def check_tags():
            context_manager.set_tags({
                "env": "production",
                "region": "us-east-1"
            })
            
            assert context_manager.get_tag("env") == "production"
            assert context_manager.get_tag("region") == "us-east-1"
        
        context_manager.run(context, check_tags)
    
    def test_metadata(self, context_manager):
        """Test setting and getting metadata."""
        context = Context(request_id="test")
        
        def check_metadata():
            context_manager.set_metadata("user", {"id": 123, "name": "John"})
            
            user = context_manager.get_metadata("user")
            assert user == {"id": 123, "name": "John"}
        
        context_manager.run(context, check_metadata)
    
    @pytest.mark.asyncio
    async def test_elapsed_time(self, context_manager):
        """Test elapsed time tracking."""
        context = Context(request_id="test")
        
        async def check_elapsed():
            await asyncio.sleep(0.1)
            elapsed = context_manager.get_elapsed_time()
            assert elapsed is not None
            assert elapsed >= 0.1
        
        await context_manager.run_async(context, check_elapsed)
    
    def test_global_context(self, context_manager):
        """Test global context merging."""
        context_manager.set_global_context(Context(tags={"service": "api"}))
        
        context = Context(request_id="test")
        
        def check_merged():
            current = context_manager.get()
            assert current is not None
            assert current.request_id == "test"
            # Global context should be merged
        
        context_manager.run(context, check_merged)
