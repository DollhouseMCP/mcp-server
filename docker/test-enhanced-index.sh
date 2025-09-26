#!/bin/bash
# Test script for Enhanced Capability Index in Docker

echo "Testing Enhanced Capability Index in Docker..."
echo "=========================================="

# Create a test portfolio directory with some elements
mkdir -p /tmp/test-portfolio/personas
mkdir -p /tmp/test-portfolio/skills
mkdir -p /tmp/test-portfolio/templates

# Create a few test personas
cat > /tmp/test-portfolio/personas/creative-writer.md << 'EOF'
---
name: Creative Writer
version: 1.0.0
description: A creative writer who helps with storytelling
triggers: [write, story, creative, narrative]
keywords: [fiction, storytelling, creative-writing, narrative]
---

# Creative Writer Persona

You are a creative storyteller focused on engaging narratives.
EOF

cat > /tmp/test-portfolio/personas/code-reviewer.md << 'EOF'
---
name: Code Reviewer
version: 1.0.0
description: Expert code reviewer focused on quality and security
triggers: [review, code, security, quality]
keywords: [code-review, security, quality-assurance, best-practices]
---

# Code Reviewer Persona

You provide thorough code reviews with constructive feedback.
EOF

cat > /tmp/test-portfolio/skills/debug-helper.md << 'EOF'
---
name: Debug Helper
version: 1.0.0
description: Helps with debugging and troubleshooting
triggers: [debug, fix, troubleshoot, error]
keywords: [debugging, troubleshooting, problem-solving]
---

# Debug Helper Skill

Systematic approach to debugging and problem resolution.
EOF

echo "Test portfolio created at /tmp/test-portfolio"
echo ""

# Run the Docker container with the test portfolio
echo "Starting DollhouseMCP server in Docker..."
docker run -d \
  --name dollhouse-test \
  -v /tmp/test-portfolio:/home/dollhouse/.dollhouse/portfolio \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -p 8765:8765 \
  dollhouse-test:develop

echo "Waiting for server to start..."
sleep 5

# Check if server is running
echo ""
echo "Server status:"
docker ps | grep dollhouse-test

echo ""
echo "Server logs:"
docker logs dollhouse-test --tail 20

echo ""
echo "Testing Enhanced Index MCP tools..."
echo "====================================="

# Test the MCP tools using curl (simulate MCP requests)
echo ""
echo "1. Testing find_similar_elements tool:"
echo "Looking for elements similar to 'creative writing'..."

# Create a test request for similar elements
cat > /tmp/test-request.json << 'EOF'
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "find_similar_elements",
    "arguments": {
      "reference_text": "creative writing and storytelling",
      "element_type": "personas",
      "limit": 5
    }
  },
  "id": 1
}
EOF

echo ""
echo "2. Testing search_by_verb tool:"
echo "Searching for elements that can 'debug'..."

# Test verb search
cat > /tmp/test-verb.json << 'EOF'
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "search_by_verb",
    "arguments": {
      "verb": "debug",
      "limit": 5
    }
  },
  "id": 2
}
EOF

echo ""
echo "3. Testing get_relationship_stats tool:"
echo "Getting relationship statistics..."

cat > /tmp/test-stats.json << 'EOF'
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_relationship_stats",
    "arguments": {}
  },
  "id": 3
}
EOF

echo ""
echo "Test complete. Cleaning up..."
docker stop dollhouse-test
docker rm dollhouse-test
rm -rf /tmp/test-portfolio
rm /tmp/test-*.json

echo ""
echo "Enhanced Index Docker test finished!"