# Flag rollout hash parity and migration

2026-10-20. Python's FNV-1a previously iterated Unicode code points while the
existing TypeScript implementation hashes JavaScript UTF-16 code units. Keys or
user IDs containing characters outside the Basic Multilingual Plane could
therefore receive different rollout buckets across SDKs.

Python now hashes explicit UTF-16 little-endian code units without a BOM, using
surrogate-pass encoding to preserve lone surrogates as JavaScript does. The
existing TypeScript hash and bucket assignments are unchanged. Eight shared
fixed vectors cover ASCII, BMP accents/CJK, non-BMP user IDs and keys, lone high
and low surrogates, and combining characters. No Unicode normalization is added.

Compatibility: Python assignments for non-BMP identifiers can change. Before
upgrading a running Python evaluator, inventory such flag/user identifiers and
compare rollout assignments using the supplied vectors/algorithm. Coordinate
SDK upgrades and bootstrap/config rollout so the same user is not evaluated by
mixed old/new Python hashing. Existing ASCII/BMP and lone-surrogate code-unit
assignments remain unchanged. This is an explicit parity correction, not a claim
that every existing Python rollout retains its assignment. No persistent
assignment migration or legacy hashing mode is provided in this checkpoint.
