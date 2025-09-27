# DollhouseMCP Capability Index

Check this index FIRST before using tools.

ELEMENT_SEARCH_HIERARCHY:
  DEFAULT ORDER (when location unspecified):
    1. Active (already loaded) - 0 tokens
    2. Local (~/.dollhouse/portfolio) - 50 tokens
    3. GitHub (user's portfolio) - 100 tokens
    4. Collection (community library) - 150 tokens

  OVERRIDE: Explicit location in query overrides default

TOOL_CAPABILITIES:
  search_portfolio: FINDS elements in local storage
  search_collection: FINDS elements in community library
  portfolio_element_manager: MANAGES GitHub portfolio
  get_active_elements: CHECKS what's currently loaded
  activate_element: LOADS element into context
  create_element: CREATES new element
  edit_element: MODIFIES existing element

WORKFLOW_HINTS:
  For debugging: Check active, then search local, then collection
  For memories: Check if exists first, then edit or create
  For security: Stay local only, never search collection
