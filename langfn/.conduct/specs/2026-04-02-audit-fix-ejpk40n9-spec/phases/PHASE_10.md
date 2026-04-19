# Phase goal

Ship the runnable documentation, compatibility matrix, and release-gate automation needed to declare LangFn production ready.

# In scope

- Root and language-specific README refresh.
- Provider compatibility documentation and release checklist artifacts.
- Repo-root release-gate scripts and smoke tests for build, HTTP, MCP, and observability parity.
- Final production-readiness verification across both languages.

# Out of scope

- Net-new runtime features not already specified in earlier phases.
- CI-only wiring; all phase verification remains locally runnable from repo root.

# Deliverables

- `langfn/README.md`
- `langfn/SPEC.md`
- `langfn/typescript/README.md`
- `langfn/python/README.md`
- `langfn/COMPATIBILITY.md`
- `langfn/.conduct/release-gate.md`
- `langfn/typescript/tests/release-gate.test.ts`
- `langfn/python/tests/test_release_gate.py`
- `scripts/gate-langfn-release.mjs`
- `package.json`

# Requirements covered

- `QUAL-001`
- `PKG-002`
- `API-001`
- `ENG-001`

# Implementation tasks

1. Refresh the root and language-specific READMEs so every documented install/import/example path is runnable from the shipped package surfaces.
2. Publish a provider compatibility matrix that records completion, chat, streaming, tools, embeddings, and evaluation support per first-party adapter.
3. Add a LangFn-specific release-gate script under `scripts/` and wire it into the repo root `package.json` scripts.
4. Make the release gate run the repo-root TypeScript build/test, Python test suite, package import smoke checks, HTTP route smoke checks, MCP transport smoke checks, observability smoke checks, and duplication gate.
5. Add final release-gate tests that assert cross-language API parity at the documented surfaces.
6. Update `langfn/SPEC.md` or adjacent docs where necessary so the shipped behavior matches the final implementation contract exactly.

# Verification steps

1. Run `npm --prefix langfn/typescript run build`.
   Expected outcome: the TypeScript package builds cleanly for release.
2. Run `npm --prefix langfn/typescript test`.
   Expected outcome: the full TypeScript suite passes from repo root.
3. Run `python3 -m pytest langfn/python/tests -q`.
   Expected outcome: the full Python test suite passes from repo root.
4. Run `node scripts/gate-langfn-release.mjs`.
   Expected outcome: the release gate exits successfully after package, HTTP, MCP, observability, duplication, and parity smoke checks complete.

# Stop condition

- Stop after the documentation is runnable, the compatibility matrix and release-gate artifacts are committed, and the full repo-root release gate passes without manual patch-ups.
