# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-12

### Added
- Initial release of CacheFn Python SDK
- Memory storage backend with LRU eviction
- Core cache operations (get, set, delete, clear)
- Batch operations (get_many, set_many, delete_many)
- TTL-based expiration
- Tag-based invalidation
- Pattern-based key matching and invalidation
- Function memoization (async and sync)
- Cache-aside pattern (get_or_fetch)
- Event system for monitoring
- Statistics tracking
- Comprehensive test suite
- Examples and documentation

### Features
- Zero external dependencies (only Pydantic for types)
- Full type hints and Pydantic models
- Async-first design
- Namespace support for key isolation
- Custom key generators for memoization
- Event handlers for cache operations
- Hit/miss rate tracking
- Memory usage estimation

[0.1.0]: https://github.com/21nCo/super-functions/releases/tag/cachefn-py-v0.1.0
