#!/bin/bash

# Publish Python packages to PyPI
# Usage: ./scripts/publish-python.sh <package-path> [--test]
#
# Examples:
#   ./scripts/publish-python.sh packages/python-core
#   ./scripts/publish-python.sh authfn/python --test
#   ./scripts/publish-python.sh browsefn/python

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if package path is provided
if [ -z "$1" ]; then
    echo -e "${RED}Error: Package path required${NC}"
    echo "Usage: $0 <package-path> [--test]"
    echo ""
    echo "Available packages:"
    find . -name "pyproject.toml" -path "*/python/*" | sed 's|./||' | sed 's|/pyproject.toml||' | sort
    exit 1
fi

PACKAGE_PATH="$1"
TEST_PYPI=""

# Check if --test flag is provided
if [ "$2" = "--test" ]; then
    TEST_PYPI="--repository testpypi"
    echo -e "${YELLOW}Publishing to TestPyPI${NC}"
fi

# Navigate to package directory
cd "$PACKAGE_PATH" || exit 1

echo -e "${GREEN}Publishing package from: $PACKAGE_PATH${NC}"

# Check if pyproject.toml exists
if [ ! -f "pyproject.toml" ]; then
    echo -e "${RED}Error: pyproject.toml not found in $PACKAGE_PATH${NC}"
    exit 1
fi

# Extract package name and version
PACKAGE_NAME=$(grep '^name = ' pyproject.toml | head -1 | cut -d'"' -f2)
PACKAGE_VERSION=$(grep '^version = ' pyproject.toml | head -1 | cut -d'"' -f2)

echo -e "${GREEN}Package: ${PACKAGE_NAME}${NC}"
echo -e "${GREEN}Version: ${PACKAGE_VERSION}${NC}"

# Clean previous builds
echo -e "${YELLOW}Cleaning previous builds...${NC}"
rm -rf dist/ build/ *.egg-info

# Build the package
echo -e "${YELLOW}Building package...${NC}"
python -m build

# Check the distribution
echo -e "${YELLOW}Checking distribution...${NC}"
python -m twine check dist/*

# Upload to PyPI
echo -e "${YELLOW}Uploading to PyPI...${NC}"
if [ -n "$TEST_PYPI" ]; then
    python -m twine upload $TEST_PYPI dist/*
else
    echo -e "${YELLOW}Ready to upload to PyPI. Continue? (y/n)${NC}"
    read -r CONFIRM
    if [ "$CONFIRM" = "y" ]; then
        python -m twine upload dist/*
        echo -e "${GREEN}Successfully published ${PACKAGE_NAME} ${PACKAGE_VERSION}!${NC}"
    else
        echo -e "${YELLOW}Upload cancelled${NC}"
    fi
fi
