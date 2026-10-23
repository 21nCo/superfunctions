# Publishing Python Packages

This guide explains how to publish superfunctions Python packages to PyPI.

## Prerequisites

### 1. Create PyPI Account
- Create account at https://pypi.org/account/register/
- Create account at https://test.pypi.org/account/register/ (for testing)
- Enable 2FA (required)
- Create API tokens:
  - Go to Account Settings → API tokens
  - Create token with scope for the packages you want to publish
  - Save the token securely

### 2. Configure PyPI Credentials

Create `~/.pypirc`:

```ini
[distutils]
index-servers =
    pypi
    testpypi

[pypi]
username = __token__
password = pypi-YOUR-API-TOKEN-HERE

[testpypi]
repository = https://test.pypi.org/legacy/
username = __token__
password = pypi-YOUR-TESTPYPI-TOKEN-HERE
```

Set permissions:
```bash
chmod 600 ~/.pypirc
```

### 3. Install Build Tools

You need `build` and `twine` in your Python environment. Use a virtual environment:

```bash
# Create a venv for publishing (one-time setup)
python3 -m venv ~/.venvs/publishing
source ~/.venvs/publishing/bin/activate
pip install --upgrade pip build twine
```

**Important:** Always activate this venv before publishing:
```bash
source ~/.venvs/publishing/bin/activate
```

## Package Publishing Order

Due to dependencies, publish packages in this order:

### 1. Core Foundation (publish first)
```bash
packages/python-core          # superfunctions
```

### 2. Framework Adapters
```bash
packages/python-sqlalchemy    # superfunctions-sqlalchemy
packages/python-fastapi       # superfunctions-fastapi
packages/python-flask         # superfunctions-flask
```

### 3. Function Packages (can be done in any order)
```bash
authfn/python                 # authfn
browsefn/python               # browsefn
cachefn/python                # cachefn
datafn/python                 # datafn
flowfn/python                 # flowfn
langfn/python                 # langfn
memoryfn/python               # memoryfn
plugfn/python                 # plugfn
secfn/python                  # secfn
sendfn/python                 # sendfn
testfn/python                 # testfn
watchfn/python                # watchfn
```

## Publishing Steps

### Quick Start

1. Activate the publishing environment:
```bash
source ~/.venvs/publishing/bin/activate
cd /Users/ar/dev/superfunctions
```

2. Make the publish script executable (one-time):
```bash
chmod +x scripts/publish-python.sh
```

3. Publish a package:
```bash
# Test first with TestPyPI
./scripts/publish-python.sh packages/python-core --test

# Then publish to real PyPI
./scripts/publish-python.sh packages/python-core
```

### Manual Publishing Process

If you prefer to do it manually:

```bash
# 1. Navigate to package
cd packages/python-core

# 2. Clean previous builds
rm -rf dist/ build/ *.egg-info

# 3. Build
python -m build

# 4. Check the distribution
python -m twine check dist/*

# 5. Test upload to TestPyPI (optional but recommended)
python -m twine upload --repository testpypi dist/*

# 6. Upload to PyPI
python -m twine upload dist/*
```

## Version Management

### Updating Versions

Before publishing, update the version in `pyproject.toml`:

```toml
[project]
name = "superfunctions"
version = "0.1.1"  # Update this
```

Follow semantic versioning:
- **MAJOR**: Breaking changes (e.g., 1.0.0 → 2.0.0)
- **MINOR**: New features, backwards compatible (e.g., 0.1.0 → 0.2.0)
- **PATCH**: Bug fixes, backwards compatible (e.g., 0.1.0 → 0.1.1)

### Dependency Versions

When updating dependencies, consider:

```toml
dependencies = [
    "superfunctions>=0.1.0",        # Use >= for stable deps
    "pydantic>=2.5.0,<3.0.0",      # Use >= with upper bound for external deps
]
```

## Testing Published Packages

### Test Installation from TestPyPI

```bash
# Create a test environment
python3 -m venv /tmp/test-install
source /tmp/test-install/bin/activate

# Install from TestPyPI
pip install --index-url https://test.pypi.org/simple/ \
    --extra-index-url https://pypi.org/simple/ \
    superfunctions

# Test it works
python -c "import superfunctions; print('Success!')"

# Cleanup
deactivate
rm -rf /tmp/test-install
```

### Test Installation from PyPI

```bash
python3 -m venv /tmp/test-install
source /tmp/test-install/bin/activate
pip install superfunctions
python -c "import superfunctions; print('Success!')"
deactivate
rm -rf /tmp/test-install
```

## Bulk Publishing

To publish all packages at once (use with caution!):

```bash
#!/bin/bash
source ~/.venvs/publishing/bin/activate

# Core first
./scripts/publish-python.sh packages/python-core

# Framework adapters
./scripts/publish-python.sh packages/python-sqlalchemy
./scripts/publish-python.sh packages/python-fastapi
./scripts/publish-python.sh packages/python-flask

# Function packages
for pkg in authfn browsefn cachefn datafn flowfn langfn memoryfn plugfn secfn sendfn testfn watchfn; do
    ./scripts/publish-python.sh "${pkg}/python"
done
```

## Troubleshooting

### Error: externally-managed-environment

**Solution:** Use a virtual environment (as shown above). Never use `--break-system-packages`.

### Error: File already exists

This means the version is already published. You need to:
1. Update the version in `pyproject.toml`
2. Rebuild and upload again

### Error: Invalid credentials

Check your `~/.pypirc` file and ensure:
- Token starts with `pypi-`
- Token has correct permissions
- File has correct permissions (`chmod 600 ~/.pypirc`)

### Error: Package name already taken

If publishing for the first time and name is taken:
- Check if you own it on PyPI
- Consider a different name
- Add organization prefix: `21n-browsefn`

## Pre-publish Checklist

Before publishing any package:

- [ ] Update version in `pyproject.toml`
- [ ] Update CHANGELOG or release notes
- [ ] Ensure all tests pass
- [ ] Check dependencies are correct
- [ ] Verify README.md is up to date
- [ ] Test build locally (`python -m build`)
- [ ] Test on TestPyPI first
- [ ] Tag the release in git after publishing

## Best Practices

1. **Always test on TestPyPI first** before publishing to PyPI
2. **Use semantic versioning** consistently
3. **Keep changelogs** updated
4. **Test installations** in fresh environments
5. **Coordinate releases** when multiple packages depend on each other
6. **Use git tags** to mark releases: `git tag v0.1.0 && git push --tags`

## Resources

- [Python Packaging Guide](https://packaging.python.org/)
- [PyPI Publishing Tutorial](https://packaging.python.org/tutorials/packaging-projects/)
- [Semantic Versioning](https://semver.org/)
- [Twine Documentation](https://twine.readthedocs.io/)
