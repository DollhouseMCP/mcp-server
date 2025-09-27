# Claude Code Capability Index Test Results

**Date**: September 21, 2025
**Time Started**: 3:05 PM PST
**Test Environment**: Real Claude Code + DollhouseMCP in Docker

## Test Setup

Using the existing Docker infrastructure:
- **Claude Code**: v1.0.110
- **DollhouseMCP**: Latest build
- **Model**: Claude 3.5 Sonnet
- **API**: Real Anthropic API calls

## Test Variants

1. **Minimal**: Just hierarchy + tools
2. **With Hints**: Hierarchy + tools + workflow hints
3. **Explicit**: Strong instructions + intent mapping
4. **Control**: No capability index

## Test Queries

1. "I need help debugging an error in my code"
2. "Search the collection for a creative writing persona"
3. "Remember that our API endpoint changed to /v2/users"
4. "Check my local portfolio for security tools"
5. "What personas are currently active?"

## Test Execution

Starting test run...==========================================
Capability Index Claude Code Testing
Test Directory: docker-test-runs/claude-1758477697
==========================================
Building Docker test environment...

[1;33m=== Starting Capability Index Tests ===[0m

================================================
Query: "I need help debugging an error in my code"
================================================

[1;33mTesting: minimal[0m
Query: "I need help debugging an error in my code"
