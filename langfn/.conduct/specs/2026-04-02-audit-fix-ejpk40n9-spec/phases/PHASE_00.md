# Phase goal

Repair the LangFn package/export contract so both language SDKs install, import, build, and report a single synchronized release identity.

# In scope

- TypeScript package naming, export map, and build/test config parity.
- Python package version/export parity for the documented public API.
- README import/install examples and release metadata alignment.
- Repo-root smoke checks for package import and version consistency.

# Out of scope

- Provider runtime semantics beyond import/build readiness.
- Tool execution, streaming, HTTP, MCP, and observability behavior changes.

# Deliverables

- `langfn/typescript/package.json`
- `langfn/typescript/tsconfig.json`
- `langfn/typescript/tsup.config.ts`
- `langfn/typescript/vitest.config.ts`
- `langfn/typescript/src/index.ts`
- `langfn/typescript/src/prompts/index.ts`
- `langfn/typescript/src/tools/index.ts`
- `langfn/typescript/src/orchestration/index.ts`
- `langfn/typescript/src/graph/index.ts`
- `langfn/typescript/src/agents/index.ts`
- `langfn/typescript/src/observability/index.ts`
- `langfn/typescript/src/http/index.ts`
- `langfn/typescript/src/structured/index.ts`
- `langfn/typescript/src/rag/index.ts`
- `langfn/typescript/src/memory/index.ts`
- `langfn/typescript/src/evaluation/index.ts`
- `langfn/typescript/src/mcp/index.ts`
- `langfn/typescript/README.md`
- `langfn/python/pyproject.toml`
- `langfn/python/langfn/__init__.py`
- `langfn/python/langfn/prompts/__init__.py`
- `langfn/python/langfn/evaluation/__init__.py`
- `langfn/python/langfn/observability/__init__.py`
- `langfn/python/README.md`
- `langfn/typescript/tests/package-contract.test.ts`
- `langfn/python/tests/test_basics.py`

# Requirements covered

- `PKG-001`
- `PKG-002`

# Implementation tasks

1. Rename the TypeScript package to `langfn` and add subpath exports for every documented surface in `PKG-001`.
2. Add first-class `tsup.config.ts` and `vitest.config.ts` files and make the TypeScript build/test scripts resolve through them.
3. Align TypeScript package version, Python `pyproject.toml` version, Python `__version__`, and any health/version constants to one release number.
4. Repair Python top-level exports so `langfn`, `langfn.prompts`, `langfn.evaluation`, and `langfn.observability` expose the documented symbols without import errors.
5. Update both READMEs so install/import examples use the canonical package name and supported subpaths only.
6. Add package contract smoke tests that fail on missing exports, version drift, or broken README import paths.

# Verification steps

1. Run `npm --prefix langfn/typescript run build`.
   Expected outcome: the TypeScript package builds successfully and emits all exported entrypoints under `dist/`.
2. Run `mkdir -p .conduct/tmp && npm pack --prefix langfn/typescript --pack-destination .conduct/tmp >/dev/null`.
   Expected outcome: a tarball named `langfn-*.tgz` is produced with no pack-time errors.
3. Run `node --input-type=module -e "import { execSync } from 'node:child_process'; const tar = execSync('ls .conduct/tmp/langfn-*.tgz').toString().trim(); const pkg = JSON.parse(execSync(\`tar -xOf ${tar} package/package.json\`).toString()); if (pkg.name !== 'langfn' || !pkg.exports['./prompts'] || !pkg.exports['./mcp']) throw new Error('package contract mismatch');"`.
   Expected outcome: the command exits successfully, confirming the packed manifest exposes the canonical package name and subpaths.
4. Run `PYTHONPATH=langfn/python python3 -c "from langfn import LangFn; from langfn.prompts import PromptTemplate, ChatTemplate; from langfn.evaluation import DatasetItem; from langfn.observability import Budgets, CostMeter"`.
   Expected outcome: the import smoke command exits successfully with no import or re-export errors.
5. Run `python3 -m pytest langfn/python/tests/test_basics.py -q`.
   Expected outcome: the packaging/version smoke suite passes.

# Stop condition

- Stop after the documented public imports, packed TypeScript manifest, and version metadata all match the canonical `langfn` release contract and the verification commands pass from repo root.
