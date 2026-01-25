# BrowseFn Python SDK

> Comprehensive self-hosted web browsing and data extraction platform for developers.

The Python SDK for BrowseFn provides a unified interface for:

- Web scraping and crawling (HTML, Markdown, Text)
- Image search and download
- Geolocation services (Geocoding, Reverse Geocoding)
- Provider-agnostic interface (swap providers easily)

## Status

🚧 **Alpha**

## Features

- **Type-safe**: Built with Pydantic for robust data validation.
- **Async**: Fully asynchronous API using `httpx`.
- **Extensible**: Easy to add custom providers.
- **Batteries included**: Comes with basic providers (BeautifulSoup).

## Installation

```bash
pip install browsefn
```

## Usage

### Web Scraping

```python
import asyncio
from browsefn import browse_fn
from browsefn.web.providers.bs4 import BeautifulSoupProvider

async def main():
    # Initialize
    browse = browse_fn()
    
    # Register a provider (e.g., BeautifulSoup)
    bs4_provider = BeautifulSoupProvider()
    browse.web.register_provider("beautifulsoup", bs4_provider)
    browse.web.config.default_provider = "beautifulsoup"
    
    # Get a page
    page = await browse.web.get_page("https://example.com")
    
    print(f"Title: {page.metadata.title}")
    print(f"Content length: {len(page.content)}")

if __name__ == "__main__":
    asyncio.run(main())
```

### Configuration

You can configure BrowseFn using the `BrowseFnConfig` object.

```python
from browsefn import browse_fn, BrowseFnConfig, WebConfig

config = BrowseFnConfig(
    web=WebConfig(
        default_provider="firecrawl",
        # ...
    )
)
browse = browse_fn(config)
```

## Development

1.  **Install dependencies**:
    ```bash
    pip install -e ".[test]"
    ```

2.  **Run tests**:
    ```bash
    pytest
    ```