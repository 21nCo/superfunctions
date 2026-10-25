"""Default terminal privacy boundary; explicit allowlist uses exact JSON Pointers."""
import re
from typing import Any, Callable, Optional

from .serialization import sanitize_value
from .types import DefaultRedactionOptions

_SECRET_KEYS = {
    'apikey', 'xapikey', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'sessiontoken', 'xauthtoken',
    'password', 'passwd', 'pwd', 'secret', 'clientsecret', 'privatekey', 'credentials',
    'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'userid', 'tenantid',
}
_PATTERNS = [
    re.compile(r'\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:Bearer|Basic)\s+[^\s,;]+', re.I),
    re.compile(r'\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/\-]+=*', re.I),
    re.compile(r'\b(?:set-cookie|cookie)\s*:\s*[^\r\n]*', re.I),
    re.compile(r'''(["']?)\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret|authorization|proxy-authorization|cookie|set-cookie)\1\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)''', re.I),
    re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'),
]


def default_redactor(options: Optional[DefaultRedactionOptions] = None) -> Callable[[Any], Any]:
    if options is not None and not isinstance(options, dict):
        raise TypeError('Redaction allowlist must contain absolute JSON Pointer paths')
    paths = (options or {}).get('allowlist', [])
    if not isinstance(paths, list) or any(not isinstance(path, str) or not path.startswith('/') or re.search(r'~(?:[^01]|$)', path) for path in paths):
        raise TypeError('Redaction allowlist must contain absolute JSON Pointer paths')
    allowlist = frozenset(paths)

    def visit(value: Any, path: str, key: Optional[str] = None) -> Any:
        if value is None:
            return None
        if not isinstance(value, (dict, list)) and path in allowlist:
            return value
        if key is not None and re.sub(r'[-_\s]', '', key).lower() in _SECRET_KEYS:
            return '[redacted]'
        if isinstance(value, str):
            for pattern in _PATTERNS:
                value = pattern.sub('[redacted]', value)
            return value
        if isinstance(value, list):
            return [visit(child, path + '/' + str(index)) for index, child in enumerate(value)]
        if isinstance(value, dict):
            return {name: visit(child, path + '/' + name.replace('~', '~0').replace('/', '~1'), name) for name, child in value.items()}
        return value

    return lambda value: visit(sanitize_value(value), '')
