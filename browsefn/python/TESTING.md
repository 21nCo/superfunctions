# Installation and Testing Guide

## Installation

The browsefn Python SDK has been fully implemented. To test it, you'll need to install dependencies:

### Option 1: Using Virtual Environment (Recommended)

```bash
cd /Users/ar/dev/superfunctions/browsefn/python

# Create virtual environment
python3 -m venv .venv

# Activate it
source .venv/bin/activate

# Install package in development mode
pip install -e .

# Install optional dependencies for testing
pip install -e ".[test]"
```

### Option 2: Using System Python (if allowed)

```bash
cd /Users/ar/dev/superfunctions/browsefn/python
pip install --user -e .
```

## Quick Test

After installation, test the implementation:

```python
import asyncio
from browsefn import browse_fn, BrowseFnConfig, WebConfig, CacheConfig

async def main():
    # Initialize browsefn
    browse = browse_fn(BrowseFnConfig(
        web=WebConfig(default_provider='bs4'),
        cache=CacheConfig(enabled=True, ttl=60000)
    ))

    print("✓ BrowseFn initialized successfully")

    # Test web scraping
    page = await browse.web.get_page('https://example.com')
    print(f"✓ Page fetched: {page.metadata.title}")

    # Test cache
    stats = await browse.cache.get_stats()
    print(f"✓ Cache working: {stats.size} items")

    # Test metrics
    metrics = await browse.get_metrics()
    print(f"✓ Metrics tracking: {metrics.totalRequests} requests")

asyncio.run(main())
```

## Running Tests

```bash
# Install test dependencies
pip install -e ".[test]"

# Run tests (when test suite is created)
pytest tests/ -v
```

## Verification Checklist

- [ ] Install dependencies in virtual environment
- [ ] Run import test: `python -c "import browsefn; print(browsefn.__version__)"`
- [ ] Run basic initialization test (see Quick Test above)
- [ ] Test BS4 provider with real URL
- [ ] Test cache functionality
- [ ] Test rate limiting
- [ ] Test metrics collection

## Next Steps

1. Install dependencies using one of the methods above
2. Run the quick test to verify basic functionality
3. Create comprehensive test suite in `tests/` directory (as outlined in implementation plan)
4. Test with actual API keys for image and geo providers
