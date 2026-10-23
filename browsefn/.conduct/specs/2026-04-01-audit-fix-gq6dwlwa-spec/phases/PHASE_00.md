# Phase goal

Align BrowseFn’s public package contract, canonical provider IDs, and shared foundations before feature work begins.

## In scope / Out of scope

- **In scope**:
  - TypeScript and Python package identity
  - version and license synchronization
  - canonical provider IDs and alias maps
  - canonical error classes and router envelope helpers
  - removal of stale `ts-sdk` path references and contradictory readiness claims
- **Out of scope**:
  - full provider implementations
  - image transforms
  - geo feature completion

## Deliverables

- `browsefn/typescript/package.json`
- `browsefn/typescript/src/index.ts`
- `browsefn/typescript/src/core/types.ts`
- `browsefn/typescript/src/core/errors.ts`
- `browsefn/typescript/src/core/provider-registry.ts`
- `browsefn/python/pyproject.toml`
- `browsefn/python/browsefn/__init__.py`
- `browsefn/python/browsefn/core/types.py`
- `browsefn/python/browsefn/core/errors.py`
- `browsefn/python/browsefn/core/provider_registry.py`
- `browsefn/README.md`
- `browsefn/typescript/README.md`
- `browsefn/python/README.md`

## Requirements covered

- PKG-001
- API-001
- DOC-001

## Implementation tasks

1. Rename the TypeScript package to `browsefn` and update repository metadata to `browsefn/typescript`.
2. Synchronize BrowseFn version and license values across TypeScript, Python, and docs.
3. Introduce canonical provider registries and alias-normalization helpers in both languages.
4. Introduce one canonical error-code module in both languages.
5. Remove stale `ts-sdk`, “coming soon”, and “fully implemented” claims from BrowseFn docs.

## Verification steps

1. Run `node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('browsefn/typescript/package.json','utf8')); console.log(p.name, p.license, p.repository.directory)"`.
Expected: `browsefn Apache-2.0 browsefn/typescript`.
2. Run `python3 - <<'PY'\nimport pathlib, tomllib\npyproject = tomllib.loads(pathlib.Path('browsefn/python/pyproject.toml').read_text())\nversion = pyproject['project']['version']\ninit_text = pathlib.Path('browsefn/python/browsefn/__init__.py').read_text()\nprint(version)\nprint('__version__ = \"' + version + '\"' in init_text)\nPY`.
Expected: the same version is printed and the final line prints `True`.
3. Run `rg -n "ts-sdk|coming soon|fully implemented|@browsefn/core" browsefn/README.md browsefn/typescript/README.md browsefn/python/README.md browsefn/.conduct/QUICKSTART.md browsefn/.conduct/IMPLEMENTATION.md browsefn/python/TESTING.md`.
Expected: no matches.

## Stop condition

Report the final package name, synchronized version/license values, and the canonical provider alias map before starting TypeScript behavior fixes.
