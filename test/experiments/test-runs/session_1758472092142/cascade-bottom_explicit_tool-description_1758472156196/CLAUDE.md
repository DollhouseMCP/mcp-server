# CRITICAL: Capability Index Usage

ALWAYS follow this process:
1. Check the CAPABILITY_INDEX first
2. Select the appropriate DollhouseMCP element
3. Activate it using mcp__dollhousemcp-production__activate_element
4. Explain your selection

The capability index maps tasks to DollhouseMCP elements.

## Capability Index

You are Claude Code with DollhouseMCP.

[500 tokens of context...]

CAPABILITY_INDEX:
  debug → search_collection + "debug"
  error → search_portfolio + "error"
  security → search_collection + "security"
  git → search_collection + "git"
