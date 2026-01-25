"""
HTML utility functions
"""

from typing import List, Optional, Dict, Any
from bs4 import BeautifulSoup
import html2text
import re


def extract_text(html: str) -> str:
    """Extract plain text from HTML"""
    soup = BeautifulSoup(html, 'html.parser')
    
    # Remove script and style elements
    for element in soup(['script', 'style', 'meta', 'link']):
        element.decompose()
    
    # Get text
    text = soup.get_text()
    
    # Clean up whitespace
    lines = (line.strip() for line in text.splitlines())
    chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
    text = ' '.join(chunk for chunk in chunks if chunk)
    
    return text


def extract_links(html: str, base_url: Optional[str] = None) -> List[str]:
    """Extract all links from HTML"""
    from browsefn.utils.url_utils import resolve_url
    
    soup = BeautifulSoup(html, 'html.parser')
    links = []
    
    for anchor in soup.find_all('a', href=True):
        href = anchor['href']
        
        # Resolve relative URLs if base_url provided
        if base_url:
            href = resolve_url(base_url, href)
        
        links.append(href)
    
    return links


def extract_images(html: str, base_url: Optional[str] = None) -> List[str]:
    """Extract all image URLs from HTML"""
    from browsefn.utils.url_utils import resolve_url
    
    soup = BeautifulSoup(html, 'html.parser')
    images = []
    
    for img in soup.find_all('img', src=True):
        src = img['src']
        
        # Resolve relative URLs if base_url provided
        if base_url:
            src = resolve_url(base_url, src)
        
        images.append(src)
    
    return images


def extract_metadata(html: str) -> Dict[str, Any]:
    """Extract metadata from HTML (Open Graph, Twitter Cards, etc.)"""
    soup = BeautifulSoup(html, 'html.parser')
    metadata: Dict[str, Any] = {}
    
    # Extract title
    title_tag = soup.find('title')
    if title_tag:
        metadata['title'] = title_tag.get_text().strip()
    
    # Extract description
    desc_tag = soup.find('meta', attrs={'name': 'description'})
    if desc_tag and desc_tag.get('content'):
        metadata['description'] = desc_tag['content']
    
    # Extract keywords
    keywords_tag = soup.find('meta', attrs={'name': 'keywords'})
    if keywords_tag and keywords_tag.get('content'):
        metadata['keywords'] = [k.strip() for k in keywords_tag['content'].split(',')]
    
    # Extract author
    author_tag = soup.find('meta', attrs={'name': 'author'})
    if author_tag and author_tag.get('content'):
        metadata['author'] = author_tag['content']
    
    # Extract favicon
    favicon_tag = soup.find('link', rel='icon')
    if not favicon_tag:
        favicon_tag = soup.find('link', rel='shortcut icon')
    if favicon_tag and favicon_tag.get('href'):
        metadata['favicon'] = favicon_tag['href']
    
    # Extract Open Graph tags
    og_tags = {}
    for tag in soup.find_all('meta', property=re.compile(r'^og:')):
        prop = tag.get('property', '').replace('og:', '')
        content = tag.get('content')
        if prop and content:
            og_tags[prop] = content
    
    if og_tags:
        metadata['openGraph'] = og_tags
    
    # Extract Twitter Card tags
    twitter_tags = {}
    for tag in soup.find_all('meta', attrs={'name': re.compile(r'^twitter:')}):
        name = tag.get('name', '').replace('twitter:', '')
        content = tag.get('content')
        if name and content:
            twitter_tags[name] = content
    
    if twitter_tags:
        metadata['twitter'] = twitter_tags
    
    return metadata


def html_to_markdown(html: str) -> str:
    """Convert HTML to Markdown"""
    h = html2text.HTML2Text()
    h.ignore_links = False
    h.ignore_images = False
    h.ignore_emphasis = False
    h.body_width = 0  # Don't wrap lines
    
    markdown = h.handle(html)
    return markdown.strip()


def clean_html(html: str) -> str:
    """Clean and sanitize HTML"""
    soup = BeautifulSoup(html, 'html.parser')
    
    # Remove script and style tags
    for element in soup(['script', 'style']):
        element.decompose()
    
    return str(soup)
