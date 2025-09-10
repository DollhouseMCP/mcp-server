# MCP Tool Authorization Guide

## Overview
Claude Code requires permission to use MCP tools for security. This guide shows how to handle authorization when running Claude Code with DollhouseMCP in Docker.

## Authorization Methods

### 1. Default Mode (Interactive Only)
Asks for permission for each tool when needed.
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /home/claude/.config/claude-code/config.json
```
**Use case**: Interactive sessions where you can approve each tool

### 2. Pre-Approved Tools (Recommended)
Specify which tools are pre-approved using `--allowedTools`:
```bash
# Allow specific tools
docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /home/claude/.config/claude-code/config.json \
  --allowedTools mcp__dollhousemcp__list_elements,mcp__dollhousemcp__get_build_info
```
**Use case**: Automated testing, CI/CD, non-interactive sessions

### 3. Dangerous Skip (Not Recommended)
Bypasses ALL permission checks (requires non-root user):
```bash
docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /home/claude/.config/claude-code/config.json \
  --dangerously-skip-permissions
```
**Use case**: Isolated sandbox environments only

## Common MCP Tools

Here are the most commonly used DollhouseMCP tools you might want to pre-approve:

### Essential Tools
```bash
--allowedTools mcp__dollhousemcp__list_elements,mcp__dollhousemcp__activate_element,mcp__dollhousemcp__get_active_elements,mcp__dollhousemcp__deactivate_element
```

### Portfolio Management
```bash
--allowedTools mcp__dollhousemcp__portfolio_status,mcp__dollhousemcp__sync_portfolio,mcp__dollhousemcp__search_portfolio
```

### Collection Browsing
```bash
--allowedTools mcp__dollhousemcp__browse_collection,mcp__dollhousemcp__search_collection,mcp__dollhousemcp__get_collection_content
```

### System Information
```bash
--allowedTools mcp__dollhousemcp__get_build_info,mcp__dollhousemcp__get_user_identity
```

## Helper Script Usage

The `scripts/claude-docker.sh` script simplifies authorization:

### Allow Specific Tools
```bash
./scripts/claude-docker.sh \
  --allow mcp__dollhousemcp__list_elements,mcp__dollhousemcp__get_build_info \
  "List all personas and show version"
```

### Interactive with Pre-Approved Tools
```bash
./scripts/claude-docker.sh \
  --interactive \
  --allow mcp__dollhousemcp__list_elements,mcp__dollhousemcp__activate_element
```

### Dangerous Mode (Caution!)
```bash
./scripts/claude-docker.sh --dangerous "Do something risky"
```

## CI/CD Example

For automated testing, pre-approve only the tools you need:

```yaml
# .github/workflows/test.yml
- name: Test MCP Integration
  run: |
    echo "List all personas" | docker run -i --rm \
      -e ANTHROPIC_API_KEY="${{ secrets.ANTHROPIC_API_KEY }}" \
      claude-dollhouse-test \
      claude --model sonnet \
      --mcp-config /home/claude/.config/claude-code/config.json \
      --allowedTools mcp__dollhousemcp__list_elements
```

## Security Considerations

### ✅ Safe Approaches
1. **Specific tool approval**: Only approve tools you need
2. **Non-root user**: Container runs as `claude` user, not root
3. **Limited scope**: Each session only has approved tools

### ⚠️ Risky Approaches
1. **--dangerously-skip-permissions**: Bypasses ALL security checks
2. **Running as root**: Disabled for security reasons
3. **Wildcard patterns**: Not supported (must list tools explicitly)

## Tool Discovery

To see all available MCP tools:
```bash
echo "List all available MCP tools" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /home/claude/.config/claude-code/config.json
```

## Examples

### Example 1: List Personas (Non-Interactive)
```bash
echo "Show all personas" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet \
  --mcp-config /home/claude/.config/claude-code/config.json \
  --allowedTools mcp__dollhousemcp__list_elements
```

### Example 2: Activate Persona
```bash
echo "Activate the Creative Writer persona" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet \
  --mcp-config /home/claude/.config/claude-code/config.json \
  --allowedTools mcp__dollhousemcp__list_elements,mcp__dollhousemcp__activate_element
```

### Example 3: Full Portfolio Operations
```bash
TOOLS="mcp__dollhousemcp__list_elements"
TOOLS="$TOOLS,mcp__dollhousemcp__activate_element"
TOOLS="$TOOLS,mcp__dollhousemcp__create_element"
TOOLS="$TOOLS,mcp__dollhousemcp__edit_element"
TOOLS="$TOOLS,mcp__dollhousemcp__portfolio_status"

echo "Create a new persona called Test Assistant" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet \
  --mcp-config /home/claude/.config/claude-code/config.json \
  --allowedTools "$TOOLS"
```

## Troubleshooting

### Issue: "I need permission to use..."
**Solution**: Add the tool to `--allowedTools` list

### Issue: "--dangerously-skip-permissions cannot be used with root"
**Solution**: Already fixed - container now runs as non-root `claude` user

### Issue: Wildcard patterns don't work
**Solution**: List tools explicitly - wildcards not supported in `--allowedTools`

### Issue: Interactive mode doesn't show prompts
**Solution**: Use `-it` flags for interactive sessions

## Best Practices

1. **Principle of Least Privilege**: Only approve tools you actually need
2. **Test First**: Discover which tools are needed before automation
3. **Document Tools**: Keep a list of tools your workflows require
4. **Avoid Dangerous Mode**: Use specific tool approval instead
5. **Regular Audits**: Review which tools are being used

---

*Last Updated: September 10, 2025*