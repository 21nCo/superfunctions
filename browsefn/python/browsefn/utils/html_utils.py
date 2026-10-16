"""HTML utility functions without hard optional dependencies."""

from html import unescape
from html.parser import HTMLParser
import re
from typing import Any, Dict, List, Optional


class _SimpleHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._in_title = False
        self._skip_depth = 0
        self.title: Optional[str] = None
        self.text_parts: List[str] = []
        self.links: List[str] = []
        self.images: List[str] = []
        self.metadata: Dict[str, Any] = {}

    def handle_starttag(self, tag: str, attrs: List[tuple[str, Optional[str]]]) -> None:
        attrs_dict = {key: value or "" for key, value in attrs}
        lower_tag = tag.lower()
        if lower_tag in {"script", "style"}:
            self._skip_depth += 1
            return
        if lower_tag == "title":
            self._in_title = True
            return
        if self._skip_depth:
            return
        if lower_tag == "a" and attrs_dict.get("href"):
            self.links.append(attrs_dict["href"])
        if lower_tag == "img" and attrs_dict.get("src"):
            self.images.append(attrs_dict["src"])
        if lower_tag == "meta":
            name = attrs_dict.get("name", "")
            prop = attrs_dict.get("property", "")
            content = attrs_dict.get("content", "")
            if name == "description":
                self.metadata["description"] = content
            elif name == "keywords":
                self.metadata["keywords"] = [part.strip() for part in content.split(",") if part.strip()]
            elif name == "author":
                self.metadata["author"] = content
            elif name.startswith("twitter:"):
                twitter = self.metadata.setdefault("twitter", {})
                twitter[name.replace("twitter:", "")] = content
            elif prop.startswith("og:"):
                open_graph = self.metadata.setdefault("openGraph", {})
                open_graph[prop.replace("og:", "")] = content
        if lower_tag == "link":
            rel = attrs_dict.get("rel", "")
            if attrs_dict.get("href") and rel in {"icon", "shortcut icon"}:
                self.metadata["favicon"] = attrs_dict["href"]

    def handle_endtag(self, tag: str) -> None:
        lower_tag = tag.lower()
        if lower_tag in {"script", "style"} and self._skip_depth:
            self._skip_depth -= 1
            return
        if lower_tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = data.strip()
        if not text:
            return
        if self._in_title:
            self.title = (self.title or "") + text
        else:
            self.text_parts.append(text)


def _parse(html: str) -> _SimpleHTMLParser:
    parser = _SimpleHTMLParser()
    parser.feed(html)
    parser.close()
    return parser


def extract_text(html: str) -> str:
    parser = _parse(html)
    return " ".join(parser.text_parts)


def extract_links(html: str, base_url: Optional[str] = None) -> List[str]:
    from browsefn.utils.url_utils import resolve_url

    parser = _parse(html)
    if not base_url:
        return parser.links
    return [resolve_url(base_url, link) for link in parser.links]


def extract_images(html: str, base_url: Optional[str] = None) -> List[str]:
    from browsefn.utils.url_utils import resolve_url

    parser = _parse(html)
    if not base_url:
        return parser.images
    return [resolve_url(base_url, src) for src in parser.images]


def extract_metadata(html: str) -> Dict[str, Any]:
    parser = _parse(html)
    metadata = dict(parser.metadata)
    if parser.title:
        metadata["title"] = parser.title
    return metadata


def html_to_markdown(html: str) -> str:
    import html2text
    converter = html2text.HTML2Text()
    converter.body_width = 0
    return converter.handle(html).strip()


def clean_html(html: str) -> str:
    html = re.sub(r"<script.*?</script>", "", html, flags=re.IGNORECASE | re.DOTALL)
    html = re.sub(r"<style.*?</style>", "", html, flags=re.IGNORECASE | re.DOTALL)
    return unescape(html)


def apply_selectors(html: str, selectors) -> str:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    for selector in selectors.exclude or []:
        for node in soup.select(selector):
            node.decompose()
    if selectors.include:
        return "".join(str(node) for node in soup.select(",".join(selectors.include)))
    return str(soup)
