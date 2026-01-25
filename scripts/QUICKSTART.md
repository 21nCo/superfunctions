# Quick Start: Publishing Python Packages

## First Time Setup (Do Once)

### 1. Create Publishing Virtual Environment
```bash
python3 -m venv ~/.venvs/publishing
source ~/.venvs/publishing/bin/activate
pip install --upgrade pip build twine
deactivate
```

### 2. Set Up PyPI Credentials

Create `~/.pypirc`:
```bash
cat > ~/.pypirc << 'EOF'
[distutils]
index-servers =
    pypi
    testpypi

[pypi]
username = __token__
password = pypi-YOUR-REAL-PYPI-TOKEN

[testpypi]
repository = https://test.pypi.org/legacy/
username = __token__
password = pypi-YOUR-TESTPYPI-TOKEN
EOF

chmod 600 ~/.pypirc
```

Get tokens from:
- PyPI: https://pypi.org/manage/account/token/
- TestPyPI: https://test.pypi.org/manage/account/token/

## Every Time You Publish

### Step 1: Activate Publishing Environment
```bash
source ~/.venvs/publishing/bin/activate
cd /Users/ar/dev/superfunctions
```

### Step 2: Update Package Version

Edit the `pyproject.toml` in the package you want to publish:
```toml
version = "0.1.1"  # Increment this
```

### Step 3: Test on TestPyPI (Recommended)
```bash
./scripts/publish-python.sh packages/python-core --test
```

### Step 4: Publish to PyPI
```bash
./scripts/publish-python.sh packages/python-core
```

### Step 5: Deactivate When Done
```bash
deactivate
```

## Publishing Order (Important!)

Publish in this order due to dependencies:

1. **Core first:**
   ```bash
   ./scripts/publish-python.sh packages/python-core
   ```

2. **Framework adapters:**
   ```bash
   ./scripts/publish-python.sh packages/python-sqlalchemy
   ./scripts/publish-python.sh packages/python-fastapi
   ./scripts/publish-python.sh packages/python-flask
   ```

3. **Function packages** (any order):
   ```bash
   ./scripts/publish-python.sh authfn/python
   ./scripts/publish-python.sh browsefn/python
   ./scripts/publish-python.sh cachefn/python
   # ... etc
   ```

## Available Packages

List all packages:
```bash
./scripts/publish-python.sh
```

## Common Tasks

### Check What Would Be Published
```bash
cd packages/python-core
python -m build
python -m twine check dist/*
```

### Test Install After Publishing
```bash
python3 -m venv /tmp/test
source /tmp/test/bin/activate
pip install superfunctions  # or whatever package
python -c "import superfunctions; print('Success!')"
deactivate
rm -rf /tmp/test
```

### Publish Multiple Packages
```bash
source ~/.venvs/publishing/bin/activate

# Core
./scripts/publish-python.sh packages/python-core

# Function packages
for pkg in authfn browsefn cachefn; do
    ./scripts/publish-python.sh "${pkg}/python"
done

deactivate
```

## Troubleshooting

**Error: externally-managed-environment**
→ Activate the venv: `source ~/.venvs/publishing/bin/activate`

**Error: File already exists**
→ Version already published. Increment version in `pyproject.toml`

**Error: Invalid credentials**
→ Check `~/.pypirc` has correct tokens

## Need More Help?

See the full guide: `PYTHON_PUBLISHING.md`
