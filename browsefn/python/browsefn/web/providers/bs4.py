"""
BeautifulSoup provider for web scraping (static HTML only)
"""

import httpx
import json
from bs4 import BeautifulSoup
from typing import Optional
from datetime import datetime
from browsefn.core.types import (
    WebProvider,
    ProviderCapabilities,
    GetPageOptions,
    PageResult,
    PageMetadata
)
from browsefn.utils.html_utils import (
    extract_text,
    extract_links,
    extract_images,
    extract_metadata,
    html_to_markdown
)


class BeautifulSoupProvider:
    """BeautifulSoup-based web scraper for static HTML"""
    
    name = "bs4"
    capabilities = ProviderCapabilities(
        formats=['html', 'markdown', 'text', 'json'],
        javascript=False,
        screenshots=False,
        cookies=True,
        headers=True,
        selectors=True,
        proxy=True
    )

    async def get_page(self, url: str, options: GetPageOptions) -> PageResult:
        """Fetch and parse a web page"""
        start_time = datetime.now()
        
        timeout = (options.timeout or 30000) / 1000  # Convert ms to seconds
        headers = options.headers or {}
        
        # Build HTTP client config
        client_config = {
            'timeout': timeout,
            'headers': headers,
            'follow_redirects': True
        }
        
        if options.proxy:
            client_config['proxies'] = options.proxy
        
        # Fetch page
        async with httpx.AsyncClient(**client_config) as client:
            response = await client.get(url, cookies=options.cookies or None)
            response.raise_for_status()
            html_content = response.text
        
        soup = BeautifulSoup(html_content, 'html.parser')
        
        # Apply selectors if provided
        if options.selectors:
            if options.selectors.exclude:
                for selector in options.selectors.exclude:
                    for element in soup.select(selector):
                        element.decompose()
            
            if options.selectors.include:
                # Keep only included selectors
                included_elements = []
                for selector in options.selectors.include:
                    included_elements.extend(soup.select(selector))
                
                # Create new soup with only included elements
                if included_elements:
                    new_soup = BeautifulSoup('', 'html.parser')
                    for element in included_elements:
                        new_soup.append(element)
                    soup = new_soup
        
        # Format content based on requested format
        format_type = options.format or 'html'
        
        if format_type == 'html':
            content = str(soup)
        elif format_type == 'markdown':
            content = html_to_markdown(str(soup))
        elif format_type == 'text':
            content = extract_text(str(soup))
        elif format_type == 'json':
            # Extract structured data
            content = json.dumps({
                'title': soup.title.string if soup.title else None,
                'headings': [h.get_text().strip() for h in soup.find_all(['h1', 'h2', 'h3'])],
                'paragraphs': [p.get_text().strip() for p in soup.find_all('p')],
                'links': extract_links(str(soup), url),
                'images': extract_images(str(soup), url)
            }, indent=2)
        else:
            content = str(soup)
        
        # Extract metadata
        metadata_dict = extract_metadata(str(soup))
        metadata = PageMetadata(
            url=url,
            title=metadata_dict.get('title'),
            description=metadata_dict.get('description'),
            keywords=metadata_dict.get('keywords'),
            author=metadata_dict.get('author'),
            favicon=metadata_dict.get('favicon'),
            openGraph=metadata_dict.get('openGraph'),
            twitter=metadata_dict.get('twitter')
        )
        
        # Extract links and images
        links = extract_links(str(soup), url)
        images = extract_images(str(soup), url)
        
        # Calculate duration
        duration = (datetime.now() - start_time).total_seconds() * 1000
        
        return PageResult(
            url=url,
            content=content,
            metadata=metadata,
            links=links,
            images=images,
            provider=self.name,
            duration=duration
        )

    async def is_available(self) -> bool:
        """Check if provider is available"""
        return True

