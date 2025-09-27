# Working with DollhouseMCP

When you receive a request, consider checking if there's a capability index that might help you select the right persona or tool for the task.

## Capability Index

ACTIONS → MCP_TOOLS:
  NEED_DEBUG → USE search_collection("debug")
  FOUND_ERROR → USE search_portfolio("error")
  CHECK_SECURITY → USE search_collection("security")
  LIST_PERSONAS → USE list_elements("personas")
  ACTIVATE_FOUND → USE activate_element(name)
