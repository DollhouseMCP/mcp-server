#!/bin/bash
# Build a .mcpb (MCP Bundle / Desktop Extension) for DollhouseMCP
#
# Usage: ./scripts/build-mcpb.sh
#
# Prerequisites:
#   npm install -g @anthropic-ai/mcpb
#
# Output: dollhousemcp-<version>.mcpb in the project root
#
# This script creates a clean staging directory with only the files
# needed at runtime, installs production dependencies, and packs
# the bundle. This keeps the .mcpb small and free of dev artifacts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGING_DIR="$PROJECT_DIR/.mcpb-staging"
VERSION=$(node -e "console.log(require('$PROJECT_DIR/package.json').version)")
MANIFEST_VERSION=$(node -e "console.log(require('$PROJECT_DIR/manifest.json').version)")

cd "$PROJECT_DIR"

if [ "$VERSION" != "$MANIFEST_VERSION" ]; then
    echo "Error: package.json version ($VERSION) does not match manifest.json version ($MANIFEST_VERSION)"
    echo "Update manifest.json before building the .mcpb bundle."
    exit 1
fi

# Verify mcpb is installed
if ! command -v mcpb &> /dev/null && ! npx @anthropic-ai/mcpb --version &> /dev/null; then
    echo "Error: mcpb CLI not found. Install with: npm install -g @anthropic-ai/mcpb"
    exit 1
fi

# Ensure a clean build
echo "Building project..."
npm run build

# Create clean staging directory
echo "Creating staging directory..."
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# Copy only what's needed at runtime
cp "$PROJECT_DIR/manifest.json" "$STAGING_DIR/"
cp "$PROJECT_DIR/package.json" "$STAGING_DIR/"
cp "$PROJECT_DIR/package-lock.json" "$STAGING_DIR/" 2>/dev/null || true
cp -r "$PROJECT_DIR/dist" "$STAGING_DIR/dist"
cp -r "$PROJECT_DIR/data" "$STAGING_DIR/data"
cp -r "$PROJECT_DIR/packages" "$STAGING_DIR/packages"
cp "$PROJECT_DIR/README.md" "$STAGING_DIR/"
cp "$PROJECT_DIR/LICENSE" "$STAGING_DIR/"

# Copy icon
mkdir -p "$STAGING_DIR/docs/assets"
cp "$PROJECT_DIR/docs/assets/dollhouse-logo.png" "$STAGING_DIR/docs/assets/"

# Install production-only dependencies
echo "Installing production dependencies..."
cd "$STAGING_DIR"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
npm cache clean --force 2>/dev/null || true

# Remove test files from dist
rm -rf dist/test dist/__tests__ dist/**/*.test.js dist/**/*.spec.js 2>/dev/null || true

# Pack the bundle
echo "Packing .mcpb bundle..."
npx @anthropic-ai/mcpb pack "$STAGING_DIR" "$PROJECT_DIR/dollhousemcp-${VERSION}.mcpb"

# Clean up
rm -rf "$STAGING_DIR"

echo ""
echo "Done! Created: dollhousemcp-${VERSION}.mcpb"
ls -lh "$PROJECT_DIR/dollhousemcp-${VERSION}.mcpb"
echo ""
echo "Upload to GitHub Releases for distribution."
