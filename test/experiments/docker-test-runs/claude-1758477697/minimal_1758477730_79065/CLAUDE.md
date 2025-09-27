# DollhouseMCP Capability Index

ELEMENT_SEARCH_HIERARCHY:
  DEFAULT ORDER (when location unspecified):
    1. Active (already loaded) - 0 tokens
    2. Local (~/.dollhouse/portfolio) - 50 tokens
    3. GitHub (user's portfolio) - 100 tokens
    4. Collection (community library) - 150 tokens

TOOL_CAPABILITIES:
  search_portfolio: FINDS elements in local storage
  search_collection: FINDS elements in community library
  get_active_elements: CHECKS what's currently loaded
  activate_element: LOADS element into context
