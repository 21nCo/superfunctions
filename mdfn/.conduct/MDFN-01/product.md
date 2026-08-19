# MDFN-01 Product Contract

Status: Approved on 2026-08-12 for SFN-20.

## Purpose

mdfn is Superfunctions' Markdown-native authoring platform. Markdown is the durable, portable, reviewable, and version-control-friendly source of truth. Visual, source, preview, collaboration, and server representations are projections over that source and must never silently replace it with an opaque canonical format.

## Audiences and surfaces

- Library authors use the headless controller, parser, serializer, renderer, and extension contract.
- Application authors use DOM and source surfaces, framework lifecycle adapters, and UIFn-owned components.
- Platform operators opt into persistence, collaboration, assets, content, search, and AI boundaries.
- Authors move between visual, source, split, preview, and read-only modes without semantic drift.

## Stable outcome

The first stable line includes the environment-neutral engine, browser visual and source surfaces, React/Svelte/Solid adapters, neutral and framework UIFn chrome, extension/testing/registry packages, and the facade. Platform and ecosystem packages are separately installable and versioned so hosts pay only for capabilities they adopt.

## Non-negotiable guarantees

1. A parse followed by serialization with no edits returns the exact input bytes.
2. Supported edited syntax round-trips semantically.
3. A visual edit normalizes the smallest safely mappable top-level source region.
4. Unsupported syntax is preserved as opaque source with diagnostics.
5. Raw HTML is disabled unless a host opts in and supplies sanitation.
6. React, Svelte, Solid, and vanilla DOM adapters produce the same semantic trace.
7. The editor kernel and Markdown engine do not own application chrome; UIFn does.

## Success measures

- Preservation, security, adapter parity, lifecycle cleanup, accessibility, performance, package isolation, and packed-install gates pass.
- DocsFn uses the canonical Markdown parse pass, ContentFn exposes Markdown explicitly, and CmsFn can edit that field with mdfn.
- Server persistence is adapter-neutral, schema-wrapped internally, authorization-aware, revisioned, and self-hostable.
