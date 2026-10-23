"""Validated payload and redirect limits for local transports."""
from browsefn.core.errors import BrowseFnError
from browsefn.core.types import DestinationSecurity, ImageDownloadOptions
from browsefn.utils.destination_policy import normalize_security

DEFAULT_PAGE_BYTES = 10 * 1024 * 1024
DEFAULT_DOWNLOAD_BYTES = 25 * 1024 * 1024
DEFAULT_REDIRECTS = 5


def page_limits(security: DestinationSecurity | None):
    policy = normalize_security(security)
    return (policy.max_response_bytes if policy and policy.max_response_bytes is not None else DEFAULT_PAGE_BYTES,
            policy.max_redirects if policy and policy.max_redirects is not None else DEFAULT_REDIRECTS)


def download_limits(options: ImageDownloadOptions):
    policy = normalize_security(options.security)
    def bounded(field, policy_value, fallback):
        legacy = getattr(options, field) if field in options.model_fields_set else None
        if policy_value is None:
            return legacy if legacy is not None else fallback
        return policy_value if legacy is None else min(policy_value, legacy)
    return (bounded('max_payload_bytes', policy.max_download_bytes if policy else None, DEFAULT_DOWNLOAD_BYTES),
            bounded('max_redirects', policy.max_redirects if policy else None, DEFAULT_REDIRECTS))


def assert_page_size(content: str, security: DestinationSecurity | None):
    if len(content.encode('utf-8')) > page_limits(security)[0]:
        raise BrowseFnError('DOWNLOAD_TOO_LARGE', 'Page payload exceeds the configured maximum size.')


def resolve_download_options(options: ImageDownloadOptions):
    maximum, redirects = download_limits(options)
    return options.model_copy(update={'max_payload_bytes': maximum, 'max_redirects': redirects})
