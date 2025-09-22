# CRITICAL: Capability Index Usage

ALWAYS follow this process:
1. Check the CAPABILITY_INDEX first
2. Select the appropriate DollhouseMCP element
3. Activate it using mcp__dollhousemcp-production__activate_element
4. Explain your selection

The capability index maps tasks to DollhouseMCP elements.

## Capability Index

CAPABILITY_INDEX:
  debug → search_portfolio + "debug"
  error → search_collection + "error handling"
  security → search_collection + "security"
  persona → list_elements + "personas"
  memory → list_elements + "memories"
  install → install_collection_content

When you need a capability, check the index FIRST.
