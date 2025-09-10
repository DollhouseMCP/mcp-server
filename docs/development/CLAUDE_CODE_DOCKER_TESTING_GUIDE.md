# Claude Code Docker Testing Guide

## Overview

This guide documents how to run Claude Code in Docker containers for testing MCP servers, particularly useful for testing hotfixes, experimental features, and automated persona optimization workflows without affecting your production environment.

## Table of Contents
1. [Basic Setup](#basic-setup)
2. [Authentication Strategies](#authentication-strategies)
3. [Testing MCP Servers](#testing-mcp-servers)
4. [Automated Persona Optimization](#automated-persona-optimization)
5. [CI/CD Integration](#cicd-integration)
6. [Troubleshooting](#troubleshooting)

## Basic Setup

### Prerequisites
- Docker Desktop installed and running
- Node.js 20+ for building MCP servers
- Git for version control

### Creating the Dockerfile

```dockerfile
# Dockerfile.test
FROM node:20-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy MCP server code
COPY . /app/mcp-server/

# Build MCP server
WORKDIR /app/mcp-server
RUN npm install
RUN npm run build

# Install Claude Code from NPM
RUN npm install -g @anthropic-ai/claude-code@latest

# Create portfolio directories
RUN mkdir -p /root/.dollhouse/portfolio/templates
RUN mkdir -p /root/.dollhouse/portfolio/personas
RUN mkdir -p /root/.dollhouse/portfolio/skills

# Set environment variables
ENV DOLLHOUSE_USER="test-user"
ENV DOLLHOUSE_PORTFOLIO_DIR="/root/.dollhouse/portfolio"
ENV DEBUG="dollhouse:*"

# Configure Claude Code to use local MCP build
RUN mkdir -p /root/.config/claude-code && \
    echo '{"mcpServers": {"dollhouse-local": {"command": "node", "args": ["/app/mcp-server/dist/index.js"]}}}' \
    > /root/.config/claude-code/config.json

CMD ["claude"]
```

### Building and Running

```bash
# Build the container
docker build -f Dockerfile.test -t claude-code-test .

# Run interactively
docker run -it --rm claude-code-test

# Run with specific command
docker run -it --rm claude-code-test claude --help

# Run with volume mounts for live testing
docker run -it --rm \
    -v $(pwd)/src:/app/mcp-server/src:ro \
    -v $(pwd)/dist:/app/mcp-server/dist:ro \
    claude-code-test
```

## Authentication Strategies

### 1. API Key Authentication (Recommended for Automation)

```dockerfile
# Add to Dockerfile
ENV ANTHROPIC_API_KEY="your-api-key-here"

# Or pass at runtime
docker run -it --rm \
    -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    claude-code-test
```

**Security Note**: Never commit API keys to version control. Use secrets management.

### 2. Interactive Authentication

For development testing with full Anthropic account features:

```bash
# Run container with interactive shell
docker run -it --rm claude-code-test /bin/bash

# Inside container, authenticate
claude setup-token
# Follow the prompts to authenticate
```

### 3. Sandboxed Mode (No Authentication)

For testing MCP server functionality without Anthropic services:

```bash
# Use --dangerously-skip-permissions flag
docker run -it --rm claude-code-test \
    claude --dangerously-skip-permissions \
    --mcp-config '{"mcpServers": {"test": {"command": "node", "args": ["/app/mcp-server/dist/index.js"]}}}'
```

**Note**: This mode has limitations and cannot be used with root privileges.

### 4. Device Flow Authentication

Claude Code supports GitHub-style device flow:

```bash
# In container
claude setup-token
# Provides a code and URL
# Navigate to URL on host machine
# Enter code to authenticate
```

## Testing MCP Servers

### Basic MCP Testing

```bash
# Test specific MCP tools
docker run -it --rm claude-code-test claude --print \
    "List all templates" \
    --mcp-config '{"mcpServers": {"test": {"command": "node", "args": ["/app/mcp-server/dist/index.js"]}}}'

# Test template rendering
docker run -it --rm claude-code-test claude --print \
    "Render the test-template with name=John and value=123"
```

### Creating Test Fixtures

```dockerfile
# Add to Dockerfile
COPY test-fixtures/ /root/.dollhouse/portfolio/
```

Or create at runtime:

```bash
docker exec -it container-name bash -c 'cat > /root/.dollhouse/portfolio/templates/test.md << EOF
---
name: Test Template
variables:
  - name: test_var
---
Content with {{test_var}}
EOF'
```

### Debugging MCP Communication

```bash
# Enable debug output
docker run -it --rm \
    -e DEBUG="dollhouse:*,mcp:*" \
    claude-code-test claude --debug
```

## Automated Persona Optimization

### Concept

Use Docker containers to iteratively test and optimize personas through hundreds of interactions, collecting metrics and refining based on performance.

### Implementation Approach

```yaml
# docker-compose.optimization.yml
version: '3.8'

services:
  optimizer:
    build: .
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - OPTIMIZATION_ROUNDS=100
      - PERSONA_NAME=target-persona
    volumes:
      - ./optimization-results:/results
      - ./personas:/root/.dollhouse/portfolio/personas
    command: /app/optimize.sh
```

### Optimization Script Example

```bash
#!/bin/bash
# optimize.sh

ROUNDS=${OPTIMIZATION_ROUNDS:-100}
PERSONA=${PERSONA_NAME:-"test-persona"}

for i in $(seq 1 $ROUNDS); do
    echo "Optimization round $i/$ROUNDS"
    
    # Test persona with various prompts
    RESULT=$(claude --print \
        --model claude-3-sonnet \
        "Activate $PERSONA and complete this task..." \
        --output-format json)
    
    # Analyze results
    echo "$RESULT" >> /results/round_$i.json
    
    # Extract metrics
    SCORE=$(echo "$RESULT" | jq '.performance_score')
    
    # Modify persona based on performance
    if [ "$SCORE" -lt "0.8" ]; then
        # Adjust persona parameters
        claude --print "Edit $PERSONA to improve performance based on: $RESULT"
    fi
    
    # Rate limiting
    sleep 2
done

# Generate final report
claude --print "Analyze all results in /results and create optimization report" \
    > /results/final_report.md
```

### Metrics Collection

```javascript
// metrics-collector.js
const fs = require('fs');
const path = require('path');

class OptimizationMetrics {
    constructor() {
        this.metrics = {
            response_quality: [],
            task_completion: [],
            consistency: [],
            creativity: [],
            accuracy: []
        };
    }
    
    async testPersona(personaName, testSuite) {
        for (const test of testSuite) {
            const result = await this.runTest(personaName, test);
            this.recordMetrics(result);
        }
        return this.generateReport();
    }
    
    // ... implementation
}
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Test MCP Server

on:
  pull_request:
    branches: [main, develop]

jobs:
  test-mcp:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v4
    
    - name: Build Docker image
      run: docker build -f Dockerfile.test -t mcp-test .
    
    - name: Run MCP tests
      env:
        ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      run: |
        docker run --rm \
          -e ANTHROPIC_API_KEY \
          mcp-test \
          /app/run-tests.sh
    
    - name: Upload results
      uses: actions/upload-artifact@v4
      with:
        name: test-results
        path: test-results/
```

### Automated Testing Script

```bash
#!/bin/bash
# run-tests.sh

set -e

echo "Testing MCP Server Tools..."

# Test template rendering
claude --print \
    "Create a test template and render it with variables" \
    --output-format json \
    > /tmp/template-test.json

# Test portfolio sync
claude --print \
    "Test sync_portfolio functionality" \
    --output-format json \
    > /tmp/sync-test.json

# Validate results
if grep -q "error" /tmp/template-test.json; then
    echo "Template test failed"
    exit 1
fi

if grep -q "PORTFOLIO_SYNC_004" /tmp/sync-test.json; then
    echo "Portfolio sync test failed"
    exit 1
fi

echo "All tests passed!"
```

## Troubleshooting

### Common Issues

#### 1. Authentication Failures
```
Error: Authentication required
```
**Solution**: Ensure ANTHROPIC_API_KEY is set or use interactive authentication.

#### 2. Permission Denied
```
--dangerously-skip-permissions cannot be used with root privileges
```
**Solution**: Create a non-root user in the Dockerfile:
```dockerfile
RUN useradd -m testuser
USER testuser
```

#### 3. MCP Server Not Responding
```
MCP server timeout
```
**Solution**: Check MCP server is built correctly and path is correct in config.

#### 4. Rate Limiting
```
Error: Rate limit exceeded
```
**Solution**: Add delays between requests or use multiple API keys in rotation.

### Debug Commands

```bash
# Check Claude Code installation
docker run --rm claude-code-test claude --version

# Verify MCP server build
docker run --rm claude-code-test ls -la /app/mcp-server/dist/

# Test MCP server directly
docker run --rm claude-code-test node /app/mcp-server/dist/index.js --help

# Check configuration
docker run --rm claude-code-test cat /root/.config/claude-code/config.json
```

## Best Practices

1. **Layer Caching**: Structure Dockerfile to maximize cache reuse
2. **Volume Mounts**: Use for development to avoid rebuilds
3. **Environment Variables**: Never hardcode sensitive data
4. **Health Checks**: Add health check endpoints to MCP servers
5. **Logging**: Implement comprehensive logging for debugging
6. **Resource Limits**: Set memory and CPU limits for containers
7. **Network Isolation**: Use custom networks for security

## Security Considerations

1. **API Key Management**
   - Use secrets management systems
   - Rotate keys regularly
   - Never commit to version control

2. **Container Security**
   - Run as non-root user when possible
   - Use minimal base images
   - Scan for vulnerabilities

3. **Network Security**
   - Isolate test containers
   - Use firewalls for production
   - Encrypt sensitive data

## Future Enhancements

1. **Kubernetes Deployment**: Scale testing across multiple nodes
2. **Metrics Dashboard**: Real-time visualization of optimization progress
3. **A/B Testing**: Compare multiple persona versions simultaneously
4. **ML Integration**: Use machine learning to guide optimization
5. **Automated Reporting**: Generate detailed analysis reports

## Conclusion

Docker-based Claude Code testing provides a powerful, isolated environment for:
- Testing MCP server changes without affecting production
- Running automated optimization workflows
- CI/CD integration for quality assurance
- Scalable testing infrastructure

The key challenge remains authentication strategy, which depends on your specific use case:
- API keys for automation
- Interactive auth for development
- Device flow for hybrid approaches

This guide will be updated as new authentication methods and testing strategies emerge.

---

*Last Updated: September 10, 2025*  
*Version: 1.0.0*