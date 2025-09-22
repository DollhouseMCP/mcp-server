# DollhouseMCP Capability Index

ALWAYS follow this process:


ELEMENT_SEARCH_HIERARCHY:
  DEFAULT ORDER (when location unspecified):
    1. Active (already loaded) - 0 tokens
    2. Local (~/.dollhouse/portfolio) - 50 tokens
    3. GitHub (user's portfolio) - 100 tokens
    4. Collection (community library) - 150 tokens

  OVERRIDE: User intent always takes precedence
    - "search the collection for..." → Go directly to collection
    - "check my GitHub for..." → Go directly to GitHub portfolio
    - "look in my local..." → Go directly to local portfolio
    - "is there an active..." → Check only active elements



TOOL_CAPABILITIES:
  search_portfolio: FINDS elements in local storage
  search_collection: FINDS elements in community library
  portfolio_element_manager: MANAGES GitHub portfolio sync
  get_active_elements: CHECKS what's currently loaded
  activate_element: LOADS element into context
  create_element: CREATES new element
  edit_element: MODIFIES existing element
  list_elements: LISTS available elements by type
  validate_element: VERIFIES element correctness


PROCESS:
  1. Identify user intent
  2. Check element search hierarchy
  3. Use appropriate tool capability
  4. Activate if found, create if missing
