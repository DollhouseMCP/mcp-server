#!/bin/bash
set -e

# v1.9.13 Memory Fixes - Docker Test Runner
# Automated testing for PR #1207

echo "======================================"
echo "v1.9.13 Memory Fixes - Docker Tests"
echo "======================================"
echo ""

# Check for API key
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "❌ ERROR: ANTHROPIC_API_KEY not set"
  echo ""
  echo "Set it with:"
  echo "  export ANTHROPIC_API_KEY='your-key-here'"
  exit 1
fi

echo "✅ ANTHROPIC_API_KEY is set"
echo ""

# Navigate to test directory
cd "$(dirname "$0")"

# Cleanup old containers/volumes
echo "🧹 Cleaning up old test containers..."
docker-compose down -v 2>/dev/null || true
echo ""

# Build with latest code
echo "🔨 Building test container with v1.9.13 fixes..."
docker-compose build --no-cache
echo ""

# Run tests
echo "🧪 Running integration tests..."
echo ""
docker-compose up --exit-code-from v1913-test

# Capture exit code
EXIT_CODE=$?

echo ""
echo "======================================"
if [ $EXIT_CODE -eq 0 ]; then
  echo "✅ Tests PASSED"
else
  echo "❌ Tests FAILED (exit code: $EXIT_CODE)"
fi
echo "======================================"
echo ""

# Cleanup
echo "🧹 Cleaning up..."
docker-compose down -v

exit $EXIT_CODE