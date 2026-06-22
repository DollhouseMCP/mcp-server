/**
 * Complete set of built-in tool names for which CI enforces explicit
 * redaction registry coverage. This is not exhaustive over runtime tool names:
 * ToolClassification can evaluate unknown/runtime-registered tools, and those
 * intentionally fall through to genericRedact().
 */
export function getApprovableToolNames(): readonly string[] {
  return [
    'Bash',
    'Write',
    'Edit',
    'Read',
    'WebFetch',
    'mcp_aql_create',
    'mcp_aql_update',
    'mcp_aql_execute',
    'mcp_aql_read',
    'mcp_aql_delete',
    'install_collection_content',
  ];
}
