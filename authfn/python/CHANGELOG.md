# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - unreleased (AUTH-32 security fixes)

### Security
- Two-factor recovery codes are claimed before they are spent, and spent only while unused (conditional writes). The two-factor plugin needs a database adapter with `update_many`; `AuthFn` and `create_authfn_routes` check this at startup through plugin `validate_config`, which now runs (AUTH-32 AF-07).
- Recovery codes hashed by the TypeScript kernel with the enrollment id are accepted (AUTH-32 AF-07).
- Region lookups no longer name the user. An account in the answering region gets the same answer as an unknown identifier; an account owned by another region or authority carries `ownedElsewhere: true`. Region-mismatch errors no longer include `userId`, and `lookup` no longer raises `RegionNotFoundError` for an unknown identifier (AUTH-32 AF-10).
- OTP verification skips challenges the TypeScript kernel never admitted, comparing times as UTC instants, and picks the latest challenge by `createdAt` then `id` (AUTH-32 AF-02).

### Changed
- AuthFn schema version 3: `two_factor_enrollments` gains `failed_attempt_count` and `locked_until`, and `otp_challenges` gains the index `idx_authfn_otp_challenges_email_created_at`. Generate and apply a migration before deploying.
- The Python kernel does not enforce the TypeScript per-email OTP budget or the two-factor failed-attempt limit yet; put the HTTP rate limiter in front of those routes.

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
