#!/bin/bash

# Capability Index Test Cleanup Script
# Cleans up test processes, Docker containers, and optionally test results

echo "=== Capability Index Test Cleanup ==="
echo ""

# Kill any running test processes
echo "1. Killing running test processes..."
pkill -f "capability-index" 2>/dev/null && echo "   ✅ Killed test processes" || echo "   ℹ️  No test processes running"

# Stop any hanging Docker containers
echo "2. Stopping Docker containers..."
docker ps -q --filter "ancestor=claude-mcp-test-env" | xargs -r docker stop 2>/dev/null && echo "   ✅ Stopped containers" || echo "   ℹ️  No containers to stop"
docker ps -q --filter "ancestor=claude-mcp-test-env-v2" | xargs -r docker stop 2>/dev/null

# Clean up Docker resources
echo "3. Cleaning Docker resources..."
docker container prune -f > /dev/null 2>&1
echo "   ✅ Cleaned up stopped containers"

# Ask about test results
echo ""
read -p "4. Delete test results? (y/N): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Archive results first
    ARCHIVE_DIR="test/experiments/capability-index-archive"
    mkdir -p "$ARCHIVE_DIR"

    # Find latest session
    LATEST_SESSION=$(ls -t test/experiments/capability-index-results/ 2>/dev/null | head -1)

    if [ ! -z "$LATEST_SESSION" ]; then
        echo "   Archiving latest session to: $ARCHIVE_DIR/$LATEST_SESSION.tar.gz"
        tar -czf "$ARCHIVE_DIR/$LATEST_SESSION.tar.gz" -C test/experiments/capability-index-results "$LATEST_SESSION" 2>/dev/null
    fi

    # Remove results
    rm -rf test/experiments/capability-index-results/*
    echo "   ✅ Results deleted (archived to $ARCHIVE_DIR)"
else
    echo "   ℹ️  Keeping test results"

    # Show disk usage
    if [ -d "test/experiments/capability-index-results" ]; then
        USAGE=$(du -sh test/experiments/capability-index-results 2>/dev/null | cut -f1)
        COUNT=$(find test/experiments/capability-index-results -type f | wc -l)
        echo "   📊 Results storage: $USAGE ($COUNT files)"
    fi
fi

# Clean up temporary files
echo "5. Cleaning temporary files..."
rm -f /tmp/claude-test-* 2>/dev/null
rm -rf /tmp/tmp.* 2>/dev/null
echo "   ✅ Cleaned temporary files"

# Show Docker image status
echo ""
echo "=== Docker Image Status ==="
docker images | grep -E "REPOSITORY|claude-mcp" | head -5

echo ""
echo "=== Cleanup Complete ==="

# Show any remaining test processes
REMAINING=$(pgrep -f "capability-index" 2>/dev/null)
if [ ! -z "$REMAINING" ]; then
    echo "⚠️  Warning: Some processes still running:"
    ps aux | grep -E "capability-index" | grep -v grep
else
    echo "✅ All test processes cleaned up"
fi