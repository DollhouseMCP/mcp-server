#!/bin/bash
set -e

echo "==================================="
echo "Testing v1.9.13 Memory Fixes"
echo "==================================="
echo "API Key: ${ANTHROPIC_API_KEY:0:15}..."
echo "MCP Config: /home/claude/.config/claude-code/config.json"
echo ""

echo "Test 1: Security Scanner False Positive (Fix #1)"
echo "Attempting to activate test-security-docs memory..."
echo "Activate the test-security-docs memory. It should load successfully despite containing security terms like vulnerability, exploit, attack vector. Reply with SUCCESS or FAILURE." | claude --model sonnet --print --mcp-config /home/claude/.config/claude-code/config.json --allowedTools mcp__dollhousemcp__activate_element
echo ""

echo "Test 2: Silent Error Reporting (Fix #2)"
echo "Checking for warning logs about failed loads..."
grep -i "Failed to load.*memories" /home/claude/.claude/logs/*.log 2>/dev/null || echo "No failed load warnings (expected if all files are valid)"
echo ""

echo "Test 3: Legacy Memory Migration (Fix #3)"
echo "Running migration tool in dry-run mode..."
cd /home/claude/mcp-server
node dist/utils/migrate-legacy-memories.js /home/claude/.dollhouse/portfolio/memories
echo ""

echo "==================================="
echo "Test Summary"
echo "==================================="
echo "Test 1 (Security False Positive): Check output above"
echo "Test 2 (Error Reporting): Check logs"
echo "Test 3 (Migration Tool): Check migration output"