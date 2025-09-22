# DollhouseMCP Capability Index

YOU MUST ALWAYS FOLLOW THIS PROCESS:

1. Read the ELEMENT_SEARCH_HIERARCHY
2. Check capabilities in order: Active → Local → GitHub → Collection
3. Use the appropriate TOOL_CAPABILITIES

ELEMENT_SEARCH_HIERARCHY:
  MANDATORY ORDER (unless user specifies location):
    1. Active (get_active_elements) - 0 tokens
    2. Local (search_portfolio) - 50 tokens
    3. GitHub (portfolio_element_manager) - 100 tokens
    4. Collection (search_collection) - 150 tokens

TOOL_CAPABILITIES:
  search_portfolio: SEARCHES local ~/.dollhouse/portfolio
  search_collection: SEARCHES community library
  portfolio_element_manager: SEARCHES GitHub portfolio
  get_active_elements: LISTS currently active elements
  activate_element: ACTIVATES found element
  create_element: CREATES if not found
  edit_element: UPDATES existing element

ELEMENT_CAPABILITIES:
  memories: PROVIDE contextual information
  personas: ALTER behavioral patterns
  skills: EXECUTE specific procedures
  agents: ACHIEVE goal-oriented tasks
  templates: STRUCTURE output formats

INTENT_MAPPING:
  "debug" → search for debug skills/personas
  "memory" → check/create/edit memories
  "security" → local search only
  "git" → search collection for best practices
