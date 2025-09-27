# CRITICAL: Capability Index Usage

ALWAYS follow this process:
1. Check the CAPABILITY_INDEX first
2. Select the appropriate DollhouseMCP element
3. Activate it using mcp__dollhousemcp-production__activate_element
4. Explain your selection

The capability index maps tasks to DollhouseMCP elements.

## Capability Index

ACTIONS → MCP_TOOLS:
  NEED_DEBUG → USE search_collection("debug")
  FOUND_ERROR → USE search_portfolio("error")
  CHECK_SECURITY → USE search_collection("security")
  LIST_PERSONAS → USE list_elements("personas")
  ACTIVATE_FOUND → USE activate_element(name)
