"""Exception classes for sendfn."""


class SendfnError(Exception):
    """Base exception for all sendfn errors."""

    pass


class EmailProviderError(SendfnError):
    """Error related to email provider operations."""

    pass


class PushProviderError(SendfnError):
    """Error related to push notification provider operations."""

    pass


class SmsProviderError(SendfnError):
    """Error related to SMS provider operations."""

    pass


class SuppressionError(SendfnError):
    """Error related to suppression list operations."""

    pass


class TemplateError(SendfnError):
    """Error related to template operations."""

    pass


class DatabaseError(SendfnError):
    """Error related to database operations."""

    pass


class ValidationError(SendfnError):
    """Error related to input validation."""

    pass
