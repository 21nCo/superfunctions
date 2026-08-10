# Sub-spec: Registry and CLI

## Purpose

Define source-installable registry items, package import guidance, lock files, drift detection, and lifecycle metadata.

## Registry Item Shape

Each registry item MUST include:

```txt
component.json
files/
stories/
fixtures/
tests/
docs.mdx
tokens.json
dependencies.json
```

The manifest MUST be the source of truth.

## Manifest Schema

Required fields:

- `schemaVersion`
- `name`
- `kind`
- `status`
- `frameworks`
- `imports`
- `dependencies`
- `owners`
- `tests`
- `stories`
- `sourcePolicy`

Optional fields:

- `backing`
- `tokens`
- `recipes`
- `figma`
- `bitCompatibility`
- `tags`
- `licenseNotes`

## CLI Commands

Required commands:

```bash
uifn list
uifn info <item>
uifn add <item> --framework <framework>
uifn add <item> --framework <framework> --sf <superfunction>
uifn diff
uifn update <item>
uifn validate
```

## Source Install Behavior

`uifn add button --framework react` MUST write:

```txt
components/ui/button.tsx
components/ui/button.stories.tsx
components/ui/button.fixtures.ts
components/ui/button.test.tsx
components/ui/button.manifest.json
```

Equivalent paths MUST be idiomatic and configurable per framework.

The CLI MUST write or update:

```txt
.uifn/registry.lock
.uifn/selected-components.json
```

## Drift Detection

`uifn diff` MUST report:

- unchanged source-installed item,
- locally modified item,
- registry update available,
- checksum mismatch,
- unsupported local edit conflict,
- missing file.

The diff command MUST NOT overwrite local edits.

## Package Import Guidance

`uifn info button` MUST show:

- package import path,
- source install command,
- required peer deps,
- required tokens/theme setup,
- Storybook stories,
- supported frameworks,
- status and owner.

## Bit-like Concepts

The registry MUST borrow:

- ownership,
- dependency graph,
- component status,
- component version,
- isolated preview metadata,
- composition examples,
- release tracks.

The registry MUST NOT require Bit.

## Security and Portability

Registry locks MUST use repository-relative paths. CLI logs MUST redact secrets and absolute local paths.

