# PlugFn Directory Structure

Complete overview of the reorganized PlugFn monorepo structure.

## Overview

PlugFn is organized as a monorepo containing multiple SDKs, shared documentation, and tooling.

```
plugfn/
├── README.md                    # Main overview
├── SPEC.md                      # Full specification
├── CONTRIBUTING.md              # Contribution guidelines
├── LICENSE                      # Apache-2.0 license
├── STRUCTURE.md                 # This file
├── package.json                 # Monorepo root config
├── .gitignore                   # Root gitignore
│
├── typescript/                  # TypeScript/JavaScript SDK
│   ├── README.md               # TS SDK documentation
│   ├── IMPLEMENTATION.md        # Implementation details
│   ├── STATUS.md               # Current status
│   ├── CHANGELOG.md            # Version history
│   ├── package.json            # TS package config
│   ├── tsconfig.json           # TypeScript config
│   ├── vitest.config.ts        # Test configuration
│   ├── .eslintrc.json          # Linting rules
│   ├── .prettierrc             # Code formatting
│   ├── src/                    # Source code
│   │   ├── index.ts           # Main entry point
│   │   ├── types/             # Type definitions
│   │   ├── core/              # Core managers
│   │   ├── auth/              # Authentication
│   │   ├── providers/         # Provider implementations
│   │   ├── storage/           # Storage layer
│   │   ├── middleware/        # Middleware (retry, cache, etc.)
│   │   ├── webhooks/          # Webhook handling
│   │   ├── router/            # HTTP routing (Express, Hono)
│   │   ├── testing/           # Testing utilities
│   │   └── utils/             # Utility functions
│   ├── tests/                 # Test suite
│   │   ├── basic.test.ts
│   │   └── providers/
│   └── examples/              # Usage examples
│       ├── basic-usage.ts
│       ├── complete-workflow.ts
│       └── express-server.ts
│
├── python/                      # Python SDK (In Progress)
│   ├── README.md               # Python SDK documentation
│   ├── pyproject.toml          # Python package config
│   ├── setup.py                # Setup script
│   ├── .gitignore              # Python gitignore
│   ├── plugfn/                 # Source code
│   │   ├── __init__.py        # Package init
│   │   ├── types.py           # Type definitions
│   │   ├── core/              # Core managers
│   │   ├── auth/              # Authentication
│   │   ├── providers/         # Provider implementations
│   │   ├── storage/           # Storage layer
│   │   ├── middleware/        # Middleware
│   │   ├── webhooks/          # Webhook handling
│   │   ├── adapters/          # Framework adapters (FastAPI, Flask)
│   │   ├── testing/           # Testing utilities
│   │   └── utils/             # Utility functions
│   ├── tests/                 # Test suite
│   │   └── test_basic.py
│   ├── examples/              # Usage examples
│   │   └── basic_usage.py
│   └── docs/                  # Python-specific docs
│
├── cli/                        # CLI Tool (TypeScript)
│   ├── README.md              # CLI documentation
│   ├── package.json           # CLI package config
│   ├── tsconfig.json          # TypeScript config
│   └── src/                   # Source code
│       ├── index.ts           # CLI entry point
│       └── commands/          # CLI commands
│           ├── init.ts        # Initialize project
│           ├── generate-types.ts  # Generate types
│           ├── add-provider.ts    # Add provider
│           └── test.ts            # Test connections
│
├── docs/                       # Shared Documentation
│   ├── getting-started.md     # Getting started guide
│   ├── architecture.md        # Architecture overview
│   ├── providers/             # Provider-specific guides
│   │   ├── github.md
│   │   ├── slack.md
│   │   ├── discord.md
│   │   ├── linear.md
│   │   └── stripe.md
│   ├── examples/              # Shared examples & tutorials
│   └── api-reference/         # API documentation
│
└── providers/                  # Provider Specifications (Future)
    ├── github.json
    ├── slack.json
    └── ...                    # Machine-readable provider specs
```

## SDK Comparison

| Feature | TypeScript | Python |
|---------|-----------|---------|
| **Status** | ✅ Complete | 🚧 In Progress |
| **Core SDK** | ✅ | 📋 Planned |
| **Providers** | ✅ 5 providers | 📋 Planned |
| **OAuth** | ✅ | 📋 Planned |
| **Webhooks** | ✅ | 📋 Planned |
| **Workflows** | ✅ | 📋 Planned |
| **HTTP Adapters** | ✅ Express, Hono | 📋 FastAPI, Flask |
| **Testing Utils** | ✅ | 📋 Planned |
| **Examples** | ✅ 3 examples | 📋 Planned |

## File Counts

### TypeScript SDK
- **Source Files**: 50+
- **Test Files**: 5+
- **Example Files**: 3
- **Lines of Code**: ~8,000+

### Python SDK
- **Source Files**: 5 (scaffolding)
- **Test Files**: 1 (basic)
- **Example Files**: 1 (planned)
- **Lines of Code**: ~200 (types only)

### Documentation
- **Shared Docs**: 5 files
- **Provider Guides**: 1 (GitHub)
- **Total Docs**: 15+ files

## Development Commands

### TypeScript SDK

```bash
cd typescript

# Development
npm install
npm run build
npm run dev          # Watch mode
npm test             # Run tests

# Linting & Formatting
npm run lint
npm run format
```

### Python SDK

```bash
cd python

# Development
pip install -e ".[dev]"
pytest                # Run tests
mypy plugfn          # Type checking
ruff check plugfn    # Linting
black plugfn         # Formatting
```

### CLI Tool

```bash
cd cli

npm install
npm run build
npm link             # Install globally

# Usage
plugfn init
plugfn add-provider --name custom --auth oauth2
plugfn generate-types --all
```

### Monorepo Commands

```bash
# From root directory

# Build everything
npm run build

# Run all tests
npm run test

# Format all code
npm run format:typescript
npm run format:python

# Clean all builds
npm run clean
```

## Package Management

### TypeScript/JavaScript

Uses npm workspaces:
- Root `package.json` manages workspaces
- Shared dependencies in root
- SDK-specific dependencies in each package

### Python

Uses pip and virtual environments:
- Each SDK has own `pyproject.toml`
- Install with `pip install -e .`
- Development dependencies in `[dev]` extra

## Version Control

### Git Structure

```
plugfn/
├── .git/                  # Root git (if not in monorepo)
├── .gitignore            # Root gitignore
├── typescript/.gitignore # TS-specific
└── python/.gitignore     # Python-specific
```

### Release Management

- TypeScript: Versioned independently
- Python: Versioned independently
- Specification: Shared version across SDKs

## CI/CD (Future)

```yaml
# Planned GitHub Actions structure
.github/
  workflows/
    typescript-ci.yml     # TS tests & build
    python-ci.yml         # Python tests & build
    cli-ci.yml            # CLI tests & build
    docs.yml              # Documentation build
    release-ts.yml        # TS release
    release-py.yml        # Python release
```

## Adding New Components

### New Provider (TypeScript)

```bash
plugfn add-provider --name shopify --auth oauth2
# Creates: typescript/src/providers/shopify/index.ts
```

### New Provider (Python)

```bash
# Create manually in python/plugfn/providers/shopify.py
# Follow existing provider patterns
```

### New Documentation

```bash
# Add to docs/providers/shopify.md
# Follow existing provider guide format
```

## Migration from Old Structure

The following changes were made:

1. **Moved TypeScript SDK**: `src/` → `typescript/src/`
2. **Created Python SDK**: New `python/` directory
3. **Shared Docs**: Created `docs/` for shared documentation
4. **CLI Tool**: Kept in `cli/` at root level
5. **Root Configs**: Added monorepo `package.json`

## Future Additions

Planned additions to the structure:

- **`providers/`**: Machine-readable provider specifications
- **`dashboard/`**: Web UI for connection management
- **`.github/`**: CI/CD workflows
- **`scripts/`**: Build and deployment scripts
- **`terraform/`**: Infrastructure as code (optional)

## Related Documentation

- [Getting Started](./docs/getting-started.md)
- [Architecture](./docs/architecture.md)
- [Contributing](./CONTRIBUTING.md)
- [Specification](./SPEC.md)
- [TypeScript SDK](./typescript/README.md)
- [Python SDK](./python/README.md)
- [CLI Tool](./cli/README.md)

