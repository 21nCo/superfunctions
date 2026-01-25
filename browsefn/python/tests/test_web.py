import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from browsefn import browse_fn, WebConfig
from browsefn.web.providers.bs4 import BeautifulSoupProvider

@pytest.mark.asyncio
async def test_web_scraper_bs4():
    # Setup
    browse = browse_fn()
    bs4_provider = BeautifulSoupProvider()
    browse.web.register_provider("beautifulsoup", bs4_provider)
    browse.web.config.default_provider = "beautifulsoup"

    # Mock httpx
    # response object is synchronous
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.text = "<html><head><title>Test Page</title></head><body><h1>Hello World</h1></body></html>"
    mock_response.elapsed.total_seconds.return_value = 0.5
    mock_response.raise_for_status.return_value = None
    
    # Configure the client
    mock_client = AsyncMock()
    # client.get is async, returns coroutine that resolves to mock_response
    mock_client.get.return_value = mock_response
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    
    with patch('httpx.AsyncClient', return_value=mock_client):
        # Execute
        page = await browse.web.get_page("https://example.com")

        # Verify
        assert page.url == "https://example.com"
        assert page.metadata.title == "Test Page"
        assert page.provider == "beautifulsoup"
        assert "Hello World" in page.content
