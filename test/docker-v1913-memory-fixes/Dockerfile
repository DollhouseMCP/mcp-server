FROM node:20-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create claude user
RUN useradd -m -s /bin/bash claude
WORKDIR /home/claude

# Copy the local MCP server source with our v1.9.13 fixes
COPY --chown=claude:claude . /home/claude/mcp-server/

# Build the MCP server
WORKDIR /home/claude/mcp-server
RUN npm ci && npm run build

# Install Claude Code CLI (correct package name)
RUN npm install -g @anthropic-ai/claude-code@latest

# Setup MCP configuration
RUN mkdir -p /home/claude/.config/claude-code
RUN echo '{ \
  "mcpServers": { \
    "dollhousemcp": { \
      "command": "node", \
      "args": ["/home/claude/mcp-server/dist/index.js"], \
      "env": { \
        "NODE_ENV": "development", \
        "LOG_LEVEL": "info", \
        "DOLLHOUSE_PORTFOLIO_DIR": "/home/claude/.dollhouse/portfolio", \
        "DOLLHOUSE_CACHE_DIR": "/home/claude/.dollhouse/cache" \
      } \
    } \
  } \
}' > /home/claude/.config/claude-code/config.json

# Setup DollhouseMCP directories with date-organized structure
RUN mkdir -p /home/claude/.dollhouse/portfolio/memories/2025-09-28 /home/claude/.dollhouse/cache

# Create a test memory that mimics sonarcloud-rules-reference
# This contains security-related terms that trigger the old validation bug
RUN echo 'metadata:' > /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '  name: test-security-docs' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '  description: Test memory with security documentation that triggers false positives' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '  version: 1.0.0' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '  author: docker-test' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '  created: 2025-09-28T00:00:00Z' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '  tags: [security, documentation, test]' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo 'entries:' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '  - id: security_rule_1' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '    timestamp: 2025-09-28T10:00:00Z' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '    content: |' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '      Rule S1234: Prevent SQL Injection vulnerability' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '      Description: This security rule detects potential exploit vectors' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '      Fix: Use parameterized queries to prevent attack vectors' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '      Severity: CRITICAL - security hotspot detected' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml && \
    echo '    tags: [vulnerability, security, sql-injection]' >> /home/claude/.dollhouse/portfolio/memories/2025-09-28/test-security-docs.yaml

# Create legacy .md files in root for migration testing (Fix #3)
RUN echo '---' > /home/claude/.dollhouse/portfolio/memories/legacy-test.md && \
    echo 'name: legacy-test' >> /home/claude/.dollhouse/portfolio/memories/legacy-test.md && \
    echo 'description: Legacy markdown memory for migration testing' >> /home/claude/.dollhouse/portfolio/memories/legacy-test.md && \
    echo 'version: 1.0' >> /home/claude/.dollhouse/portfolio/memories/legacy-test.md && \
    echo 'created: 2025-08-01T00:00:00Z' >> /home/claude/.dollhouse/portfolio/memories/legacy-test.md && \
    echo '---' >> /home/claude/.dollhouse/portfolio/memories/legacy-test.md && \
    echo '' >> /home/claude/.dollhouse/portfolio/memories/legacy-test.md && \
    echo '# Legacy Memory' >> /home/claude/.dollhouse/portfolio/memories/legacy-test.md && \
    echo 'This is old format content.' >> /home/claude/.dollhouse/portfolio/memories/legacy-test.md

# Setup apiKeyHelper
RUN mkdir -p /home/claude/.claude && \
    echo '#!/bin/bash' > /home/claude/.claude/anthropic_key_helper.sh && \
    echo 'echo ${ANTHROPIC_API_KEY}' >> /home/claude/.claude/anthropic_key_helper.sh && \
    chmod +x /home/claude/.claude/anthropic_key_helper.sh

# Set ownership
RUN chown -R claude:claude /home/claude

USER claude
WORKDIR /home/claude

# Configure Claude
RUN claude config set --global apiKeyHelper /home/claude/.claude/anthropic_key_helper.sh

# Create comprehensive test script
RUN echo '#!/bin/bash' > /home/claude/test-v1913-fixes.sh && \
    echo 'set -e' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "==================================="' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "Testing v1.9.13 Memory Fixes"' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "==================================="' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo ""' >> /home/claude/test-v1913-fixes.sh && \
    echo '' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "Test 1: Security Scanner False Positive (Fix #1)"' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "Attempting to activate test-security-docs memory..."' >> /home/claude/test-v1913-fixes.sh && \
    echo 'claude --model sonnet --print \' >> /home/claude/test-v1913-fixes.sh && \
    echo '  --mcp-config /home/claude/.config/claude-code/config.json \' >> /home/claude/test-v1913-fixes.sh && \
    echo '  --allowedTools mcp__dollhousemcp__activate_element \' >> /home/claude/test-v1913-fixes.sh && \
    echo '  --prompt "Activate the test-security-docs memory. It should load successfully despite containing security terms like vulnerability, exploit, attack vector. Reply with SUCCESS or FAILURE."' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo ""' >> /home/claude/test-v1913-fixes.sh && \
    echo '' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "Test 2: Silent Error Reporting (Fix #2)"' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "Checking for warning logs about failed loads..."' >> /home/claude/test-v1913-fixes.sh && \
    echo 'grep -i "Failed to load.*memories" /home/claude/.claude/logs/*.log 2>/dev/null || echo "No failed load warnings (expected if all files are valid)"' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo ""' >> /home/claude/test-v1913-fixes.sh && \
    echo '' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "Test 3: Legacy Memory Migration (Fix #3)"' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "Running migration tool in dry-run mode..."' >> /home/claude/test-v1913-fixes.sh && \
    echo 'cd /home/claude/mcp-server' >> /home/claude/test-v1913-fixes.sh && \
    echo 'node dist/utils/migrate-legacy-memories.js /home/claude/.dollhouse/portfolio/memories' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo ""' >> /home/claude/test-v1913-fixes.sh && \
    echo '' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "==================================="' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "Test Summary"' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "==================================="' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "Test 1 (Security False Positive): Check output above"' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "Test 2 (Error Reporting): Check logs"' >> /home/claude/test-v1913-fixes.sh && \
    echo 'echo "Test 3 (Migration Tool): Check migration output"' >> /home/claude/test-v1913-fixes.sh && \
    chmod +x /home/claude/test-v1913-fixes.sh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node /home/claude/mcp-server/dist/index.js --version || exit 1

CMD ["/home/claude/test-v1913-fixes.sh"]