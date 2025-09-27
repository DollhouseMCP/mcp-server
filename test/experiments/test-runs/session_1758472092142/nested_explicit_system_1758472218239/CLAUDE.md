# CRITICAL: Capability Index Usage

ALWAYS follow this process:
1. Check the CAPABILITY_INDEX first
2. Select the appropriate DollhouseMCP element
3. Activate it using mcp__dollhousemcp-production__activate_element
4. Explain your selection

The capability index maps tasks to DollhouseMCP elements.

## Capability Index

capabilities:
  development:
    debugging:
      tools: [search_portfolio, search_collection]
      query: ["debug", "error", "troubleshoot"]
    security:
      tools: [search_collection]
      query: ["security", "vulnerability"]
  workflow:
    git: [search_collection with "git"]
    personas: [list_elements with "personas"]
