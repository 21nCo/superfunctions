# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-18

### Added
- Placement-bound auth context issuer (`create_placement_context_issuer`) for trusted in-process and private-service consumers.

### Changed
- API-key sessions match the TypeScript `authfn` package (0.5.0 and later): a user-owned key authenticates as its owner (`actor_type='user'`, `actor_id` and `subject` = the owner's user ID), and an unowned service key keeps `actor_type='api-key'` with the key ID.
- `AuthFnSession` has a `credential` field (`AuthFnApiKeyCredential`, `{type: 'api-key', id}`), set for every API-key session.
- A key whose owner was deleted or is disabled (`metadata["disabled"] is True` on the user record) fails authentication: `ApiKeyService.authenticate` returns `None` without updating `lastUsedAt`, and the placement-context issuer raises `UnauthorizedError`. Both paths share `find_active_api_key_owner`.
- In an API-key session's `metadata`, `ownerUserId` and `scopes` are written after the key's stored metadata, so stored metadata can no longer override them.
- Package description now describes the Python kernel rather than an API-key-only library.

### Removed
- Standalone-SDK wrapper debris: `setup.py`, interactive `publish.sh` / `Makefile`, unused `black` extra, dead `authfn/adapter.py`, and bootstrap docs (`IMPLEMENTATION_SUMMARY.md`, `PACKAGE_INFO.md`, `COMPARISON.md`, `INSTALLATION.md`, `QUICKSTART.md`, `PUBLISHING.md`).
- Dead `__getattr__` lazy-import for `SocialOAuth*` names that were already exported at module load.

## [0.1.0] - 2026-01-12

### Added
- Initial release of authfn Python SDK
- API key generation with cryptographically secure random generation
- Authentication via Bearer token
- Authorization for resource-based access control
- Key revocation support
- Key expiration with automatic checking
- Metadata support for custom key metadata
- Scopes support for optional scope-based permissions
- Database abstraction using Protocol-based adapter pattern
- Schema definition for declarative database table generation
- Type safety with Pydantic models and runtime validation
- Full async/await support throughout
- Custom exception classes for error handling
- Comprehensive test suite with 11 test cases
- Mock database adapter for testing
- Complete documentation:
  - README.md with usage examples
  - INSTALLATION.md with setup instructions
  - COMPARISON.md comparing TypeScript and Python implementations
  - IMPLEMENTATION_SUMMARY.md with implementation details
  - PUBLISHING.md with publishing guide
  - QUICKSTART.md for quick reference
- Example code in `examples/basic_usage.py`
- Development tools:
  - pytest configuration
  - mypy type checking
  - ruff linting
  - black formatting
  - Makefile for common tasks
  - Publishing script

### Core Features
- `AuthFn` class for main functionality
- `AuthFnProvider` class for authentication and authorization
- `create_authfn()` factory function
- `generate_api_key()` for secure key generation
- `generate_id()` for unique ID generation

### Type Definitions
- `ApiKeySession` - Session data after authentication
- `ApiKey` - Complete API key data
- `ApiKeyCreate` - Input data for creating keys
- `ApiKeyResponse` - Response with ID and secret key
- `ApiKeySanitized` - API key without secret
- `AuthFnConfig` - Configuration model
- `WhereClause` - Database query clause
- `OrderByClause` - Database ordering clause

### Protocols
- `DatabaseAdapter` - Protocol for database implementations
- `Request` - Protocol for HTTP request objects
- `AuthProvider` - Protocol for auth providers

### Dependencies
- pydantic>=2.5.0 - Data validation and type safety
- cryptography>=41.0.0 - Cryptographic operations

### Python Support
- Python 3.10+
- Python 3.11
- Python 3.12

[Unreleased]: https://github.com/21nCo/superfunctions/compare/python-authfn-v0.2.0...HEAD
[0.2.0]: https://github.com/21nCo/superfunctions/releases/tag/python-authfn-v0.2.0
[0.1.0]: https://github.com/21nCo/super-functions/releases/tag/v0.1.0
