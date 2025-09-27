FROM node:20-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create claude user
RUN useradd -m -s /bin/bash claude
WORKDIR /home/claude

# Copy the local MCP server source with our fix
COPY --chown=claude:claude . /home/claude/mcp-server/

# Build the MCP server
WORKDIR /home/claude/mcp-server
RUN npm ci && npm run build

# Install Claude Code CLI
RUN npm install -g @anthropic/claude-code@latest

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

# Setup DollhouseMCP directories
RUN mkdir -p /home/claude/.dollhouse/portfolio/memories /home/claude/.dollhouse/cache

# Create a test memory with the old authentication solution
RUN echo "metadata:" > /home/claude/.dollhouse/portfolio/memories/docker-claude-code-authentication-solution.yaml && \
    echo "  name: docker-claude-code-authentication-solution" >> /home/claude/.dollhouse/portfolio/memories/docker-claude-code-authentication-solution.yaml && \
    echo "  description: Test memory for edit fix" >> /home/claude/.dollhouse/portfolio/memories/docker-claude-code-authentication-solution.yaml && \
    echo "  version: 1.0.0" >> /home/claude/.dollhouse/portfolio/memories/docker-claude-code-authentication-solution.yaml && \
    echo "entries:" >> /home/claude/.dollhouse/portfolio/memories/docker-claude-code-authentication-solution.yaml && \
    echo "  - id: test_entry_1" >> /home/claude/.dollhouse/portfolio/memories/docker-claude-code-authentication-solution.yaml && \
    echo "    timestamp: '2025-09-22T09:00:00Z'" >> /home/claude/.dollhouse/portfolio/memories/docker-claude-code-authentication-solution.yaml && \
    echo "    content: 'Original test content'" >> /home/claude/.dollhouse/portfolio/memories/docker-claude-code-authentication-solution.yaml && \
    echo "    tags: [test, original]" >> /home/claude/.dollhouse/portfolio/memories/docker-claude-code-authentication-solution.yaml

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

# Create test script
RUN echo '#!/bin/bash' > /home/claude/test-memory-edit.sh && \
    echo 'echo "Testing memory edit with string timestamp..."' >> /home/claude/test-memory-edit.sh && \
    echo 'echo "{\"name\":\"docker-claude-code-authentication-solution\",\"type\":\"memory\",\"field\":\"entries\",\"value\":[{\"id\":\"test_fix_entry\",\"timestamp\":\"2025-09-22T11:00:00Z\",\"content\":\"Testing memory edit fix #1069\",\"tags\":[\"test\",\"fix\"]}]}" | \' >> /home/claude/test-memory-edit.sh && \
    echo 'claude --model sonnet --print \' >> /home/claude/test-memory-edit.sh && \
    echo '  --mcp-config /home/claude/.config/claude-code/config.json \' >> /home/claude/test-memory-edit.sh && \
    echo '  --allowedTools mcp__dollhousemcp-production__edit_element \' >> /home/claude/test-memory-edit.sh && \
    echo '  --prompt "Use mcp__dollhousemcp-production__edit_element with this JSON data to edit the memory"' >> /home/claude/test-memory-edit.sh && \
    chmod +x /home/claude/test-memory-edit.sh

CMD ["/home/claude/test-memory-edit.sh"]