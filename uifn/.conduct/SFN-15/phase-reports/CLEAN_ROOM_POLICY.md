# SFN-15 Clean-room Implementation Policy

## Scope

This policy applies to all SFN-15 implementation work for `uifn`.

## Rules

- Public documentation for Coss UI, Radix UI, Base UI, shadcn, Storybook, and Bit MAY be used to understand capability categories, naming expectations, accessibility goals, and consumer workflows.
- Source code, private implementation details, prose, examples, CSS, assets, tests, and generated files from those projects MUST NOT be copied into `uifn`.
- If a component name overlaps with a public ecosystem name, the implementation MUST be derived from platform standards, ARIA practices, internal requirements, and `uifn` controllers.
- Every registry manifest MUST include `sourcePolicy: "clean-room"`.
- Any third-party runtime or build dependency MUST be explicitly declared and justified by package role.
- If a proven domain library is used for complex behavior, the implementation MUST depend on it through its public package and license rather than copying internals.
- Storybook and Bit concepts MAY be borrowed as product model ideas; Storybook and Bit MUST NOT become hidden sources of truth for `uifn` manifests.

## Disallowed Evidence

The following are not acceptable as implementation inputs:

- copied source code,
- copied tests,
- copied examples,
- copied CSS,
- copied documentation prose,
- copied images or icons,
- private screenshots of implementation internals,
- unlicensed snippets from public documentation.

## Allowed Evidence

The following are acceptable:

- public component names for catalog mapping,
- public accessibility standards,
- ARIA authoring practices,
- platform API documentation,
- internally authored SFN-15 specs and test vectors,
- observed behavior from using public demos when rewritten independently,
- permissively licensed third-party package usage through dependency declarations.

## Review Gate

Before a package can claim GA, release verification MUST include a source-provenance check that fails on copied external source, copied external docs, or unexpected third-party assets.
