#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

packages=("core" "client" "svelte" "server" "cli")

for pkg in "${packages[@]}"; do
  echo "Building $pkg..."
  npm run build --prefix "$SCRIPT_DIR/$pkg"
  echo "----------------------------------------"
done

echo "All packages built successfully."
