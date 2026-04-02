/**
 * IntrospectionResolver - GraphQL-style introspection for MCP-AQL
 *
 * Provides discovery capabilities for LLMs to understand available operations,
 * their parameters, return types, and examples.
 *
 * INTROSPECTION QUERIES:
 * - operations: List all available operations
 * - operation(name): Get details for a specific operation
 * - types: List available types (ElementType, etc.)
 * - type(name): Get details for a specific type
 * - categories: Category format rules + discovery guidance (Issue #631)
 *
 * DESIGN RATIONALE:
 * - Token-efficient: Returns minimal but useful information
 * - Self-documenting: Operations describe themselves
 * - Read-only: Safe to call at any time (no side effects)
 *
 * SCHEMA INTEGRATION (Issue #254):
 * - Schema-driven operations get their metadata from OperationSchema
 * - Legacy operations use the fallback OPERATION_PARAMETERS/OPERATION_EXAMPLES
 * - This ensures single source of truth for schema-driven operations
 */

import { OPERATION_ROUTES, type CRUDEndpoint } from './OperationRouter.js';
import { PermissionGuard, type EndpointPermissions } from './PermissionGuard.js';
import { ElementType } from './types.js';
import { getAllowedGroupByFields } from '../../services/query/AggregationService.js';
import { VALIDATION_PATTERNS } from '../../security/constants.js';
import {
  getOperationSchema,
  getAnyOperationSchema,
  schemaToParameterInfo,
  type OperationDef,
} from './OperationSchema.js';

// ============================================================================
// Response Types
// ============================================================================

/**
 * Basic information about an operation (used in list responses)
 */
export interface OperationInfo {
  /** Operation name (e.g., 'create_element') */
  name: string;
  /** CRUD endpoint this operation belongs to */
  endpoint: string;
  /** Brief description of what the operation does */
  description: string;
}

/**
 * Parameter information for operation details
 */
export interface ParameterInfo {
  /** Parameter name */
  name: string;
  /** Parameter type (e.g., 'string', 'ElementType', 'object') */
  type: string;
  /** Whether the parameter is required */
  required: boolean;
  /** Brief description of the parameter */
  description: string;
  /** Default value if any */
  default?: unknown;
}

/**
 * Return type information
 */
export interface TypeInfo {
  /** Type name */
  name: string;
  /** Type kind (enum, object, scalar, union) */
  kind: 'enum' | 'object' | 'scalar' | 'union';
  /** Brief description */
  description?: string;
}

/**
 * Detailed information about a specific operation
 */
export interface OperationDetails {
  /** Operation name */
  name: string;
  /** CRUD endpoint */
  endpoint: string;
  /** MCP tool name (e.g., 'mcp_aql_read') */
  mcpTool: string;
  /** Full description */
  description: string;
  /** Permission flags */
  permissions: EndpointPermissions;
  /** Parameter definitions */
  parameters: ParameterInfo[];
  /** Return type information */
  returns: TypeInfo;
  /** Usage examples */
  examples: string[];
  /** Alternative operation names that resolve to this operation */
  aliases?: string[];
}

/**
 * Detailed type information with enum values or object fields
 */
export interface TypeDetails {
  /** Type name */
  name: string;
  /** Type kind */
  kind: 'enum' | 'object' | 'scalar' | 'union';
  /** Full description */
  description: string;
  /** Enum values (for enum types) */
  values?: string[];
  /** Object fields (for object types) */
  fields?: ParameterInfo[];
  /** Union member types (for union types) */
  members?: string[];
}

/**
 * Format specification for an element type (Issue #715)
 */
export interface FormatSpec {
  /** Element type this spec describes */
  elementType: string;
  /** File format used for storage */
  fileFormat: string;
  /** Required fields in frontmatter */
  requiredFields: string[];
  /** Optional fields in frontmatter */
  optionalFields: string[];
  /** Guidance on using instructions vs content fields */
  dualFieldGuidance: string;
  /** Syntax notes specific to this element type */
  syntaxNotes: string[];
  /** Minimal working example */
  minimalExample: string;
  /** Full-featured example */
  fullExample: string;
  /** Naming conventions for this element type */
  namingConventions: string[];
}

/**
 * Result of an introspection query
 */
export interface IntrospectionResult {
  /** List of operations (for 'operations' query) */
  operations?: OperationInfo[];
  /** Single operation details (for 'operation(name)' query) */
  operation?: OperationDetails | null;
  /** List of types (for 'types' query) */
  types?: TypeInfo[];
  /** Single type details (for 'type(name)' query) */
  type?: TypeDetails | null;
  /** Format specification (for 'format' query) */
  formatSpec?: FormatSpec | FormatSpec[] | null;
  /** Category discovery info (for 'categories' query, Issue #631) */
  categories?: Record<string, unknown>;
}

// ============================================================================
// Type Definitions Registry
// ============================================================================

/**
 * Registry of all types available in MCP-AQL
 * This is the source of truth for type introspection
 */
const TYPE_DEFINITIONS: Record<string, TypeDetails> = {
  ElementType: {
    name: 'ElementType',
    kind: 'enum',
    description: 'The 6 core element types supported by DollhouseMCP',
    values: Object.values(ElementType),
  },
  CRUDEndpoint: {
    name: 'CRUDEndpoint',
    kind: 'enum',
    description: 'CRUDE endpoint categories for operation classification (CRUD + Execute)',
    values: ['CREATE', 'READ', 'UPDATE', 'DELETE', 'EXECUTE'],
  },
  OperationInput: {
    name: 'OperationInput',
    kind: 'object',
    description: 'Standard input structure for all MCP-AQL operations',
    fields: [
      {
        name: 'operation',
        type: 'string',
        required: true,
        description: 'The operation to perform',
      },
      {
        name: 'elementType',
        type: 'ElementType',
        required: false,
        description: 'Element type for element operations',
      },
      {
        name: 'params',
        type: 'object',
        required: false,
        description: 'Operation-specific parameters',
      },
    ],
  },
  OperationResult: {
    name: 'OperationResult',
    kind: 'union',
    description: 'Standard result type for all operations (success or failure)',
    members: ['OperationSuccess', 'OperationFailure'],
  },
  OperationSuccess: {
    name: 'OperationSuccess',
    kind: 'object',
    description: 'Successful operation result',
    fields: [
      {
        name: 'success',
        type: 'boolean',
        required: true,
        description: 'Always true for success',
        default: true,
      },
      {
        name: 'data',
        type: 'unknown',
        required: true,
        description: 'Operation-specific result payload',
      },
    ],
  },
  OperationFailure: {
    name: 'OperationFailure',
    kind: 'object',
    description: 'Failed operation result',
    fields: [
      {
        name: 'success',
        type: 'boolean',
        required: true,
        description: 'Always false for failure',
        default: false,
      },
      {
        name: 'error',
        type: 'string',
        required: true,
        description: 'Human-readable error message',
      },
    ],
  },
  EndpointPermissions: {
    name: 'EndpointPermissions',
    kind: 'object',
    description: 'Permission flags for CRUD endpoints',
    fields: [
      {
        name: 'readOnly',
        type: 'boolean',
        required: true,
        description: 'Whether the operation only reads data',
      },
      {
        name: 'destructive',
        type: 'boolean',
        required: true,
        description: 'Whether the operation can delete or modify data',
      },
    ],
  },
};

// ============================================================================
// Element Format Specifications (Issue #715)
// ============================================================================

/**
 * Map from ElementType value to plural form for normalization.
 * "memories" -> "memory", "personas" -> "persona", etc.
 */
const PLURAL_TO_TYPE: Record<string, string> = {
  personas: 'persona',
  skills: 'skill',
  templates: 'template',
  agents: 'agent',
  memories: 'memory',
  ensembles: 'ensemble',
};

/**
 * Normalize a user-provided type name to an ElementType value.
 * Handles: lowercase, plural forms, leading/trailing whitespace, non-string input.
 */
function normalizeTypeName(name: unknown): string | undefined {
  if (!name || typeof name !== 'string') return undefined;
  const lower = name.trim().toLowerCase();
  if (Object.values(ElementType).includes(lower as ElementType)) {
    return lower;
  }
  return PLURAL_TO_TYPE[lower];
}

const SHARED_NAMING = [
  'Use lowercase kebab-case: my-element-name',
  'Max 100 characters, must start with a letter',
  'Allowed: letters, digits, hyphens, underscores',
];

/**
 * Format specifications for each element type.
 * Returned by introspect query: "format".
 *
 * @see Issue #715 - Proactive LLM guidance for element creation
 */
const FORMAT_SPECS: Record<string, FormatSpec> = {
  persona: {
    elementType: 'persona',
    fileFormat: 'Markdown with YAML frontmatter',
    requiredFields: ['name', 'description'],
    optionalFields: ['version', 'tags', 'author', 'instructions', 'content', 'gatekeeper'],
    dualFieldGuidance: 'instructions: Behavioral directives in command voice ("You ARE...", "ALWAYS...", "NEVER..."). content: Optional background lore, context, or reference material. For personas, instructions is the primary field.',
    syntaxNotes: [
      'File extension: .md',
      'Frontmatter delimited by --- on its own line',
      'Body text after frontmatter becomes the instructions field',
      'No template variable substitution in personas',
      'gatekeeper: Dynamic security policy — takes effect when this persona is activated, reverts when deactivated. Example: a "focused-work" persona that denies web browsing tools while active, or an "open-research" persona that allows broad access. Structure: { allow?: string[], confirm?: string[], deny?: string[], scopeRestrictions?: { allowedTypes?, blockedTypes? } }. Priority: deny > confirm > allow > route default.',
    ],
    minimalExample: `---
name: my-persona
description: A helpful assistant
---
You ARE a helpful assistant. ALWAYS be concise and accurate.`,
    fullExample: `---
name: security-analyst
description: Cybersecurity specialist focused on threat modeling
version: 1
tags: [security, analysis]
author: team-lead
---
You ARE a cybersecurity expert with 15 years of experience.
ALWAYS consider threat models before suggesting solutions.
NEVER recommend security through obscurity.
PRIORITIZE defense-in-depth strategies.`,
    namingConventions: [
      ...SHARED_NAMING,
      'Describe the role: security-analyst, code-reviewer, technical-writer',
    ],
  },

  skill: {
    elementType: 'skill',
    fileFormat: 'Markdown with YAML frontmatter',
    requiredFields: ['name', 'description'],
    optionalFields: ['version', 'tags', 'author', 'category', 'instructions', 'content', 'gatekeeper'],
    dualFieldGuidance: 'instructions: Behavioral directives for when the skill is active ("When triggered, ANALYZE...", "ALWAYS check..."). content: Domain knowledge, reference material, checklists, examples. Best practice: use BOTH for rich skills.',
    syntaxNotes: [
      'File extension: .md',
      'Frontmatter delimited by --- on its own line',
      'Body text after frontmatter becomes the content field',
      'category must match: ^[a-zA-Z][a-zA-Z0-9\\-_]{0,20}$',
      'gatekeeper: Dynamic security policy — takes effect when this skill is activated, reverts when deactivated. Example: a "code-review" skill that auto-approves read operations but confirms edits, or a "read-only" skill that denies all write operations. Structure: { allow?: string[], confirm?: string[], deny?: string[], scopeRestrictions?: { allowedTypes?, blockedTypes? } }.',
    ],
    minimalExample: `---
name: code-review
description: Reviews code for quality issues
---
When reviewing code: ALWAYS check for security vulnerabilities first.`,
    fullExample: `---
name: code-review
description: Reviews code for quality and security
version: 1
tags: [development, quality]
author: dev-team
category: development
---
When reviewing code: ALWAYS check for security vulnerabilities first.
ANALYZE complexity and suggest simplifications.
FORMAT feedback as actionable bullet points.

# Reference Material

## Security Checklist
- SQL injection
- XSS vulnerabilities
- Unvalidated input

## Quality Metrics
- Cyclomatic complexity < 10
- Test coverage > 80%`,
    namingConventions: [
      ...SHARED_NAMING,
      'Describe the capability: code-review, threat-modeling, data-analysis',
    ],
  },

  template: {
    elementType: 'template',
    fileFormat: 'Markdown with YAML frontmatter',
    requiredFields: ['name', 'description'],
    optionalFields: ['version', 'tags', 'author', 'category', 'variables', 'gatekeeper'],
    dualFieldGuidance: 'content (REQUIRED): The template body. Use {{variable_name}} for substitution. instructions: Not typically used for templates. For page-level templates with CSS/JS, use section format instead of plain content.',
    syntaxNotes: [
      'File extension: .md',
      'Variable syntax: {{variable_name}} — simple substitution only',
      'NO Handlebars: {{#if}}, {{#each}}, {{> partial}} are NOT supported',
      'Section format for page templates: <template>HTML with {{vars}}</template> <style>CSS</style> <script>JS</script>',
      'In section format: only <template> is variable-processed; <style> and <script> are raw passthrough (}} is safe there)',
      'Declare variables in frontmatter: variables: [{ name, type, required, description }]',
      'For lists, tables, or conditional content: pass pre-formatted markdown strings as variables',
      'category must match: ^[a-zA-Z][a-zA-Z0-9\\-_]{0,20}$',
      'gatekeeper: Dynamic security policy — takes effect when this template is activated, reverts when deactivated. Example: a sensitive report template that denies deletion while active, protecting it from accidental removal during use. Structure: { allow?: string[], confirm?: string[], deny?: string[], scopeRestrictions?: { allowedTypes?, blockedTypes? } }.',
    ],
    minimalExample: `---
name: bug-report
description: Bug report template
variables:
  - { name: summary, type: string, required: true }
  - { name: steps, type: string, required: true }
---
## Bug Report

**Summary:** {{summary}}
**Steps to Reproduce:** {{steps}}`,
    fullExample: `---
name: dashboard-page
description: Full-page dashboard with styles and scripts
variables:
  - { name: title, type: string, required: true }
  - { name: body, type: string, required: false }
---
<template>
<!DOCTYPE html>
<html>
<head><title>{{title}}</title></head>
<body>{{body}}</body>
</html>
</template>

<style>
body { font-family: sans-serif; }
.card { border: 1px solid #ccc; } /* }} safe here */
</style>

<script>
var state = { status: "all" };
function update() { return { bar: baz }; } // }} safe here
</script>`,
    namingConventions: [
      ...SHARED_NAMING,
      'Describe the output: bug-report, meeting-notes, dashboard-page',
    ],
  },

  agent: {
    elementType: 'agent',
    fileFormat: 'Markdown with YAML frontmatter',
    requiredFields: ['name', 'description'],
    optionalFields: ['version', 'tags', 'author', 'instructions', 'content', 'goal', 'activates', 'tools', 'systemPrompt', 'autonomy', 'resilience', 'gatekeeper'],
    dualFieldGuidance: 'instructions: Semantic behavioral profile — personality and approach (distinct from systemPrompt). content: Reference material the agent can consult during execution. goal (RECOMMENDED): Structured goal with template, parameters, and successCriteria. systemPrompt: LLM system prompt for execution context.',
    syntaxNotes: [
      'File extension: .md',
      'goal.template uses {param} placeholders (single braces, NOT {{}})',
      'goal.parameters: array of { name, type, required, description, default? }',
      'goal.successCriteria: string array of completion conditions',
      'activates: { personas?: string[], skills?: string[], memories?: string[], templates?: string[], ensembles?: string[] }',
      'tools: { allowed: string[], denied?: string[] }',
      'autonomy: { maxAutonomousSteps, allowedActions, requireConfirmation } (defaults apply if omitted)',
      'resilience: Governs automatic recovery during execute_agent. { onStepLimitReached?: "pause"|"continue"|"restart", onExecutionFailure?: "pause"|"retry"|"restart-fresh", maxRetries?: number (default 3), maxContinuations?: number (default 10), retryBackoff?: "linear"|"exponential", preserveState?: boolean }. Without resilience, execution pauses at limits and failures (safe default).',
      'activates lifecycle: Elements in activates are automatically activated when execute_agent starts — their gatekeeper policies, instructions, and capabilities become active for the execution duration.',
      'gatekeeper: Dynamic security policy — takes effect when this agent is activated, reverts when deactivated. Gives users composable security control: activate a locked-down agent and writes are blocked; deactivate it and full access returns. Structure: { allow?: string[], confirm?: string[], deny?: string[], scopeRestrictions?: { allowedTypes?: string[], blockedTypes?: string[] } }. allow/confirm/deny are operation name patterns (e.g. "read_*", "execute_agent", "delete_element"). scopeRestrictions limits which element types the policy governs. Priority: deny > confirm > allow > route default. If omitted, inherits system defaults (which already require confirmation for sensitive operations).',
    ],
    minimalExample: `---
name: code-reviewer
description: Reviews code for quality issues
---
You are a thorough code reviewer.`,
    fullExample: `---
name: code-reviewer
description: Reviews code for quality and security issues
version: 1
tags: [development, security]
author: dev-team
goal:
  template: "Review the code at {path} for {focus_area}"
  parameters:
    - { name: path, type: string, required: true, description: "File or directory" }
    - { name: focus_area, type: string, required: false, description: "security | quality | performance", default: quality }
  successCriteria:
    - All issues documented
    - Severity ratings assigned
    - Fixes suggested
activates:
  skills: [code-review]
  personas: [security-analyst]
tools:
  allowed: [read_file, list_directory]
systemPrompt: Be specific about line numbers and provide concrete fix suggestions.
autonomy:
  maxAutonomousSteps: 10
resilience:
  onStepLimitReached: continue
  onExecutionFailure: retry
  maxRetries: 3
  maxContinuations: 5
  retryBackoff: exponential
gatekeeper:
  allow: [read_element, search_elements, query_elements, list_elements]
  confirm: [execute_agent, edit_element]
  deny: [delete_element]
---
You are a thorough code reviewer who prioritizes security.`,
    namingConventions: [
      ...SHARED_NAMING,
      'Describe the agent role: code-reviewer, data-pipeline, report-generator',
    ],
  },

  memory: {
    elementType: 'memory',
    fileFormat: 'YAML',
    requiredFields: ['name', 'description'],
    optionalFields: ['version', 'tags', 'author', 'category', 'retentionDays', 'content', 'gatekeeper'],
    dualFieldGuidance: 'content: Initial entry content added at creation time. instructions: Not typically used for memories. Use addEntry operation to append structured entries after creation.',
    syntaxNotes: [
      'File extension: .yml',
      'Entries are structured YAML objects with timestamp, content, tags, metadata',
      'Use addEntry operation to add entries (not edit_element)',
      'retentionDays controls automatic expiry of entries',
      'category must match: ^[a-zA-Z][a-zA-Z0-9\\-_]{0,20}$',
      'Naming convention for agent-linked memories: agent-{agent-name}-context',
      'Naming convention for persona-linked memories: persona-{persona-name}-preferences',
      'gatekeeper: Dynamic security policy — takes effect when this memory is activated, reverts when deactivated. Example: a confidential project memory that blocks deletion and confirms edits while active. Structure: { allow?: string[], confirm?: string[], deny?: string[], scopeRestrictions?: { allowedTypes?, blockedTypes? } }.',
    ],
    minimalExample: `# Created via create_element:
{ operation: "create_element", elementType: "memory", params: {
  element_name: "project-context",
  description: "Architecture decisions"
} }`,
    fullExample: `# Created via create_element:
{ operation: "create_element", elementType: "memory", params: {
  element_name: "project-context",
  description: "Architecture decisions and project context",
  content: "Using PostgreSQL for ACID compliance.",
  metadata: { tags: ["architecture", "database"], retentionDays: 365 }
} }

# Add entries via addEntry:
{ operation: "addEntry", params: {
  element_name: "project-context",
  content: "Switched to Redis for caching layer.",
  tags: ["architecture", "cache"]
} }`,
    namingConventions: [
      ...SHARED_NAMING,
      'Agent-linked: agent-{agent-name}-context',
      'Persona-linked: persona-{persona-name}-preferences',
      'Session-scoped: session-context',
      'Domain-specific: project-context, team-decisions',
    ],
  },

  ensemble: {
    elementType: 'ensemble',
    fileFormat: 'Markdown with YAML frontmatter',
    requiredFields: ['name', 'description', 'metadata.elements'],
    optionalFields: ['version', 'tags', 'author', 'content', 'gatekeeper'],
    dualFieldGuidance: 'content: Optional description of how the ensemble coordinates its elements. instructions: Not used for ensembles. The elements array in metadata is the core configuration.',
    syntaxNotes: [
      'File extension: .md',
      'metadata.elements is REQUIRED: array of { name, type, role }',
      'role values: "primary", "support", "override", "monitor", "core"',
      'type must be a valid ElementType: persona, skill, template, agent, memory',
      'Referenced elements must exist in the portfolio',
      'At least one element required; elements validated at creation time',
      'gatekeeper: Dynamic security policy — takes effect when this ensemble is activated, reverts when deactivated. Ensembles can define broad security postures: activate a "production-safe" ensemble and destructive operations are blocked across all its member elements. Structure: { allow?: string[], confirm?: string[], deny?: string[], scopeRestrictions?: { allowedTypes?, blockedTypes? } }.',
    ],
    minimalExample: `---
name: security-team
description: Security analysis ensemble
metadata:
  elements:
    - { name: security-analyst, type: persona, role: primary }
    - { name: threat-modeling, type: skill, role: support }
---`,
    fullExample: `---
name: security-team
description: Security analysis ensemble combining analyst persona with threat modeling
version: 1
tags: [security, analysis]
author: team-lead
metadata:
  elements:
    - { name: security-analyst, type: persona, role: primary }
    - { name: threat-modeling, type: skill, role: support }
    - { name: penetration-testing, type: skill, role: support }
---
Coordinates security analysis across multiple domains.
The security-analyst persona provides the behavioral foundation,
while skills supply domain-specific capabilities.`,
    namingConventions: [
      ...SHARED_NAMING,
      'Describe the team or combination: security-team, content-pipeline, full-stack-review',
    ],
  },
};

// ============================================================================
// Operation Parameter Definitions
// ============================================================================

/**
 * Parameter definitions for each operation
 * These are used to generate operation details
 */
const OPERATION_PARAMETERS: Record<string, ParameterInfo[]> = {
  // CREATE operations
  create_element: [
    { name: 'element_name', type: 'string', required: true, description: 'Element name' },
    { name: 'element_type', type: 'ElementType', required: true, description: 'Element type' },
    { name: 'description', type: 'string', required: true, description: 'Element description' },
    // Issue #602 resolved: Both 'instructions' and 'content' are first-class fields with distinct semantic roles.
    { name: 'instructions', type: 'string', required: false, description: 'Behavioral INSTRUCTIONS — written in active/command voice as directives the AI must follow. For personas: "You ARE a security expert. ALWAYS check for vulnerabilities." For skills: "When triggered, ANALYZE code systematically." For agents: semantic behavioral profile (distinct from systemPrompt). Optional for memories/ensembles.' },
    { name: 'content', type: 'string', required: false, description: 'Reference material, knowledge, and context. ELEMENT-SPECIFIC USAGE: Templates (REQUIRED): the template body — use {{variable_name}} for substitution. For page templates with CSS/JS use section format: <template>HTML with {{vars}}</template><style>/* }} safe here */</style><script>// }} safe here</script> — only <template> is variable-processed, <style>/<script> are raw passthrough. Skills: domain knowledge and reference examples (pair with instructions for best results). Personas: background lore/context. Agents: reference material. Memories: initial entry content.' },
    { name: 'goal', type: 'object', required: false, description: 'For agents: RECOMMENDED. Goal configuration with template (string with {param} placeholders), parameters (array of {name, type, required, description}), and successCriteria (string array).' },
    { name: 'category', type: 'string', required: false, description: 'Category label for skills, templates, and memories. Must start with a letter, followed by letters, digits, hyphens, or underscores (max 21 chars). Not supported on personas, agents, or ensembles.' },
    { name: 'metadata', type: 'object', required: false, description: 'Additional metadata. For ensembles: include elements array. For memories: use metadata.tags for tags and metadata.retentionDays for retention period.' },
    { name: 'activates', type: 'object', required: false, description: 'For V2 agents: Elements to activate at execution start. Shape: { personas?: string[], skills?: string[], memories?: string[], templates?: string[], ensembles?: string[] } — all keys optional, values are element NAMES (not IDs). Example: { skills: ["code-review", "threat-modeling"], personas: ["security-analyst"] }' },
    { name: 'tools', type: 'object', required: false, description: 'For V2 agents: Tool configuration. Object with allowed (string array) and optional denied (string array).' },
    { name: 'systemPrompt', type: 'string', required: false, description: 'For V2 agents: Custom system prompt for LLM context.' },
  ],
  import_element: [
    { name: 'data', type: 'string | object', required: true, description: 'Export package (JSON string or object)' },
    { name: 'overwrite', type: 'boolean', required: false, description: 'Overwrite if exists', default: false },
  ],
  // addEntry: migrated to MEMORY_SCHEMAS in OperationSchema.ts (Issue #594)
  activate_element: [
    { name: 'element_name', type: 'string', required: true, description: 'Element name to activate' },
    { name: 'element_type', type: 'ElementType', required: true, description: 'Element type' },
    { name: 'context', type: 'object', required: false, description: 'Activation context' },
  ],

  // READ operations
  // Note: 'fields' parameter is supported on all read operations that return element data.
  // It accepts either a preset string ('minimal', 'standard', 'full') or an array of field names.
  // See MCPAQLHandler.applyFieldSelection() for implementation details.
  list_elements: [
    { name: 'element_type', type: 'ElementType', required: true, description: 'Element type to list' },
    { name: 'page', type: 'number', required: false, description: 'Page number (1-indexed)', default: 1 },
    { name: 'pageSize', type: 'number', required: false, description: 'Items per page (max 100)', default: 20 },
    { name: 'sortBy', type: "'name' | 'created' | 'modified' | 'version'", required: false, description: 'Field to sort by', default: 'name' },
    { name: 'sortOrder', type: "'asc' | 'desc'", required: false, description: 'Sort direction', default: 'asc' },
    { name: 'nameContains', type: 'string', required: false, description: 'Filter: partial name match (case-insensitive)' },
    { name: 'tags', type: 'string[]', required: false, description: 'Filter: must have ALL specified tags (AND logic)' },
    { name: 'tagsAny', type: 'string[]', required: false, description: 'Filter: must have ANY specified tag (OR logic)' },
    { name: 'author', type: 'string', required: false, description: 'Filter: by author username' },
    { name: 'status', type: "'active' | 'inactive' | 'all'", required: false, description: 'Filter: by element status' },
    { name: 'category', type: 'string', required: false, description: 'Filter: by category (case-insensitive)' },
    { name: 'aggregate', type: 'object', required: false, description: "Aggregation: { count: true } for count only, { count: true, group_by: 'category' } for grouped counts. Allowed group_by fields: author, category, status, tags, version." },
    { name: 'fields', type: "string | string[]", required: false, description: "Field selection: preset ('minimal', 'standard', 'full') or array of field names" },
  ],
  get_element: [
    { name: 'element_name', type: 'string', required: true, description: 'Element name' },
    { name: 'element_type', type: 'ElementType', required: true, description: 'Element type' },
    { name: 'fields', type: "string | string[]", required: false, description: "Field selection: preset ('minimal', 'standard', 'full') or array of field names" },
  ],
  get_element_details: [
    { name: 'element_name', type: 'string', required: true, description: 'Element name' },
    { name: 'element_type', type: 'ElementType', required: true, description: 'Element type' },
    { name: 'fields', type: "string | string[]", required: false, description: "Field selection: preset ('minimal', 'standard', 'full') or array of field names" },
  ],
  search_elements: [
    { name: 'query', type: 'string', required: true, description: 'Search query (max 1000 chars). Supports multi-word tokenized matching across name, description, and content.' },
    { name: 'element_type', type: 'ElementType', required: false, description: 'Scope search to a single element type. Omit to search all types.' },
    { name: 'pagination', type: 'object', required: false, description: 'Pagination: { page: number (default 1), pageSize: number (default 20) }' },
    { name: 'sort', type: 'object', required: false, description: "Sort: { sortBy: 'name' (default), sortOrder: 'asc' | 'desc' (default 'asc') }" },
    { name: 'fields', type: "string | string[]", required: false, description: "Field selection: preset ('minimal', 'standard', 'full') or array of field names" },
  ],
  query_elements: [
    { name: 'element_type', type: 'ElementType', required: true, description: 'Element type to query' },
    { name: 'filters', type: 'object', required: false, description: 'Filter criteria: { nameContains, tags, tagsAny, author, createdAfter, createdBefore, status, descriptionContains, category }' },
    { name: 'sort', type: 'object', required: false, description: "Sort: { sortBy: 'name' | 'created' | 'modified' | 'version', sortOrder: 'asc' | 'desc' }" },
    { name: 'pagination', type: 'object', required: false, description: 'Pagination: { page: number (default 1), pageSize: number (default 20) }' },
    { name: 'aggregate', type: 'object', required: false, description: "Aggregation: { count: true } for count only, { count: true, group_by: 'category' } for grouped counts. Allowed group_by fields: author, category, status, tags, version." },
    { name: 'fields', type: "string | string[]", required: false, description: "Field selection: preset ('minimal', 'standard', 'full') or array of field names" },
  ],
  get_active_elements: [
    { name: 'element_type', type: 'ElementType', required: false, description: 'Filter by element type' },
    { name: 'fields', type: "string | string[]", required: false, description: "Field selection: preset ('minimal', 'standard', 'full') or array of field names" },
  ],
  validate_element: [
    { name: 'element_name', type: 'string', required: true, description: 'Element name' },
    { name: 'element_type', type: 'ElementType', required: true, description: 'Element type' },
    { name: 'strict', type: 'boolean', required: false, description: 'Strict validation mode', default: false },
  ],
  render: [
    { name: 'name', type: 'string', required: true, description: 'Template name' },
    { name: 'variables', type: 'object', required: true, description: 'Template variables' },
  ],
  export_element: [
    { name: 'element_name', type: 'string', required: true, description: 'Element name' },
    { name: 'element_type', type: 'ElementType', required: true, description: 'Element type' },
    { name: 'format', type: "'json' | 'yaml'", required: false, description: 'Export format', default: 'json' },
  ],
  deactivate_element: [
    { name: 'element_name', type: 'string', required: true, description: 'Element name' },
    { name: 'element_type', type: 'ElementType', required: true, description: 'Element type' },
  ],
  introspect: [
    { name: 'query', type: "'operations' | 'types' | 'format' | 'categories'", required: false, description: "What to introspect: 'operations' (list/detail operations), 'types' (list/detail types), 'format' (element creation format specs), 'categories' (category format rules + discovery guidance). Default: 'operations'", default: 'operations' },
    { name: 'name', type: 'string', required: false, description: "Specific item name. For 'operations': operation name. For 'types': type name. For 'format': element type (e.g. 'template', 'persona'). Not used for 'categories'. Omit for overview." },
  ],

  // UPDATE operations
  edit_element: [
    { name: 'element_name', type: 'string', required: true, description: 'Element name' },
    { name: 'element_type', type: 'ElementType', required: true, description: 'Element type' },
    { name: 'input', type: 'object', required: true, description: 'Nested object with fields to update (deep-merged with existing element). Supports: description, instructions, content, tags, metadata, and type-specific fields (goal, activates, tools, systemPrompt for agents; variables for templates). For template content syntax, use introspect with query: "format", name: "template".' },
  ],

  // DELETE operations
  delete_element: [
    { name: 'element_name', type: 'string', required: true, description: 'Element name' },
    { name: 'element_type', type: 'ElementType', required: true, description: 'Element type' },
    { name: 'deleteData', type: 'boolean', required: false, description: 'Delete associated data files' },
  ],
  // clear, execute_agent, get_execution_state, record_execution_step, complete_execution,
  // continue_execution, abort_execution, get_gathered_data, prepare_handoff, resume_from_handoff:
  // All migrated to INTROSPECTION_ONLY_SCHEMAS in OperationSchema.ts (Issue #594)
};

// ============================================================================
// Operation Examples
// ============================================================================

/**
 * Usage examples for each operation
 */
const OPERATION_EXAMPLES: Record<string, string[]> = {
  create_element: [
    // PERSONA — use instructions (behavioral directives in command voice). content is optional background lore.
    '{ operation: "create_element", elementType: "persona", params: { element_name: "SecurityExpert", description: "Cybersecurity specialist", instructions: "You ARE a cybersecurity expert with 15 years of experience. ALWAYS consider threat models before suggesting solutions. NEVER recommend security through obscurity. PRIORITIZE defense-in-depth strategies." } }',

    // SKILL — dual-field: instructions = behavioral directives, content = reference knowledge. Both together is best practice.
    '{ operation: "create_element", elementType: "skill", params: { element_name: "CodeReview", description: "Reviews code for quality and security", instructions: "When reviewing code: ALWAYS check for security vulnerabilities first. ANALYZE complexity and suggest simplifications. FORMAT feedback as actionable bullet points.", content: "# Code Review Reference\\n\\n## Security Checklist\\n- SQL injection\\n- XSS vulnerabilities\\n- Unvalidated input\\n\\n## Quality Metrics\\n- Cyclomatic complexity < 10\\n- Test coverage > 80%" } }',

    // TEMPLATE (simple) — content is the template body. Use {{variable_name}} for substitution.
    '{ operation: "create_element", elementType: "template", params: { element_name: "BugReport", description: "Bug report template", content: "## Bug Report\\n\\n**Summary:** {{summary}}\\n**Steps to Reproduce:** {{steps}}\\n**Expected:** {{expected}}\\n**Actual:** {{actual}}", metadata: { variables: [{ name: "summary", type: "string", required: true }, { name: "steps", type: "string", required: true }, { name: "expected", type: "string", required: false }, { name: "actual", type: "string", required: false }] } } }',

    // TEMPLATE (section format) — <template> for HTML+{{vars}}, <style> for CSS, <script> for JS. }} is safe in style/script.
    '{ operation: "create_element", elementType: "template", params: { element_name: "DashboardPage", description: "Full-page dashboard shell with styles and JS", content: "<template>\\n<!DOCTYPE html>\\n<html><head><title>{{title}}</title></head>\\n<body>{{body}}</body>\\n</html>\\n</template>\\n\\n<style>\\nbody { font-family: sans-serif; }\\n.card { border: 1px solid #ccc; } /* }} safe here */\\n</style>\\n\\n<script>\\nvar state = { status: \\"all\\" };\\nfunction update() { return { bar: baz }; } // }} safe here\\n</script>", metadata: { variables: [{ name: "title", type: "string", required: true }, { name: "body", type: "string", required: false }] } } }',

    // TEMPLATE (CSS theme — style-only section format)
    '{ operation: "create_element", elementType: "template", params: { element_name: "ThemeDark", description: "Dark color theme — activate to style dashboard with dark palette", content: "<style>\\n:root {\\n  --bg: #0f1117;\\n  --surface: #1a1d27;\\n  --text: #e8eaf6;\\n  --accent: #4a9eff;\\n}\\n.card { background: var(--surface); color: var(--text); }\\n</style>" } }',

    // AGENT (V2) — goal is an object, activates references elements by name, tools controls access.
    '{ operation: "create_element", elementType: "agent", params: { element_name: "CodeReviewer", description: "Reviews code for quality and security issues", goal: { template: "Review the code at {path} for {focus_area}", parameters: [{ name: "path", type: "string", required: true, description: "File or directory to review" }, { name: "focus_area", type: "string", required: false, description: "security | quality | performance", default: "quality" }], successCriteria: ["All issues documented", "Severity ratings assigned", "Fixes suggested"] }, activates: { skills: ["code-review"], personas: ["security-analyst"] }, tools: { allowed: ["read_file", "list_directory"] }, systemPrompt: "You are a thorough code reviewer. Be specific about line numbers and provide concrete fix suggestions." } }',

    // ENSEMBLE — elements array with name, type, role.
    '{ operation: "create_element", elementType: "ensemble", params: { element_name: "SecurityTeam", description: "Security analysis ensemble — combines analyst persona with threat modeling and pen testing skills", content: "Coordinates security analysis across multiple domains.", metadata: { elements: [{ name: "security-analyst", type: "persona", role: "primary" }, { name: "threat-modeling", type: "skill", role: "support" }, { name: "penetration-testing", type: "skill", role: "support" }] } } }',

    // MEMORY — content creates initial entry, tags for categorization, retentionDays for expiry.
    '{ operation: "create_element", elementType: "memory", params: { element_name: "ProjectContext", description: "Architecture decisions and project context", content: "Using PostgreSQL over MongoDB — decided 2026-03-11 for ACID compliance requirements.", metadata: { tags: ["architecture", "database"], retentionDays: 365 } } }',

    // Memory naming conventions:
    '{ operation: "create_element", elementType: "memory", params: { element_name: "agent-code-reviewer-context", description: "Execution state and learned preferences for code-reviewer agent" } }',
    '{ operation: "create_element", elementType: "memory", params: { element_name: "persona-security-analyst-preferences", description: "Personalization data for security-analyst persona" } }',
    '{ operation: "create_element", elementType: "memory", params: { element_name: "session-context", description: "Cross-element shared context for the current session" } }',
  ],
  import_element: [
    '{ operation: "import_element", params: { data: "{...exportPackage...}", overwrite: true } }',
  ],
  // addEntry: migrated to MEMORY_SCHEMAS in OperationSchema.ts (Issue #594)
  activate_element: [
    '{ operation: "activate_element", elementType: "persona", params: { element_name: "my-persona" } }',
  ],
  list_elements: [
    '{ operation: "list_elements", element_type: "persona" }',
    // Response: { items: [{ name, description, type, version, tags }], pagination: { page: 1, pageSize: 20, totalItems, totalPages, hasNextPage, hasPrevPage }, sorting: { sortBy, sortOrder }, element_type: "persona" }
    '{ operation: "list_elements", element_type: "persona", params: { page: 2, pageSize: 10 } }',
    '{ operation: "list_elements", element_type: "skill", params: { tags: ["typescript"], sortBy: "modified", sortOrder: "desc" } }',
    '{ operation: "list_elements", element_type: "persona", params: { aggregate: { count: true } } }',
    // Response: { count: 42, element_type: "persona" }
    '{ operation: "list_elements", element_type: "persona", params: { aggregate: { count: true, group_by: "category" } } }',
    // Response: { count: 42, element_type: "persona", groups: { "assistant": 15, "creative": 12, "technical": 15 } }
  ],
  get_element: [
    '{ operation: "get_element", elementType: "persona", params: { element_name: "my-persona" } }',
  ],
  get_element_details: [
    '{ operation: "get_element_details", elementType: "persona", params: { element_name: "my-persona" } }',
  ],
  search_elements: [
    '{ operation: "search_elements", params: { query: "helpful assistant" } }',
    // Response: { items: [{ type, element_name, description, matchedIn: ["name", "description"] }], pagination: { page, pageSize, totalItems, totalPages, hasNextPage, hasPrevPage }, sorting: { sortBy, sortOrder }, query: "helpful assistant" }
    '{ operation: "search_elements", element_type: "persona", params: { query: "code review", pagination: { page: 1, pageSize: 10 } } }',
    '{ operation: "search_elements", params: { query: "typescript", sort: { sortBy: "name", sortOrder: "desc" } } }',
  ],
  query_elements: [
    '{ operation: "query_elements", element_type: "persona", params: { filters: { status: "active" }, pagination: { page: 1, pageSize: 10 } } }',
    // Response: { items: [{ name, description, type, version, tags }], pagination: { page, pageSize, totalItems, totalPages, hasNextPage, hasPrevPage }, sorting: { sortBy, sortOrder }, element_type: "persona" }
    '{ operation: "query_elements", element_type: "skill", params: { filters: { tags: ["typescript"] }, sort: { sortBy: "modified", sortOrder: "desc" } } }',
    '{ operation: "query_elements", element_type: "persona", params: { aggregate: { count: true, group_by: "tags" } } }',
    // Response: { count: 42, element_type: "persona", groups: { "assistant": 15, "creative": 12 } }
  ],
  get_active_elements: [
    '{ operation: "get_active_elements", elementType: "persona" }',
  ],
  validate_element: [
    '{ operation: "validate_element", elementType: "persona", params: { element_name: "my-persona", strict: true } }',
  ],
  render: [
    '{ operation: "render", params: { element_name: "meeting-notes", variables: { date: "2024-01-15", attendees: ["Alice", "Bob"] } } }',
  ],
  export_element: [
    '{ operation: "export_element", elementType: "persona", params: { element_name: "my-persona", format: "json" } }',
  ],
  deactivate_element: [
    '{ operation: "deactivate_element", elementType: "persona", params: { element_name: "my-persona" } }',
  ],
  introspect: [
    '{ operation: "introspect", params: { query: "operations" } }',
    '{ operation: "introspect", params: { query: "operations", name: "create_element" } }',
    '{ operation: "introspect", params: { query: "types", name: "ElementType" } }',
    '{ operation: "introspect", params: { query: "format" } }',
    '{ operation: "introspect", params: { query: "format", name: "template" } }',
  ],
  edit_element: [
    '{ operation: "edit_element", elementType: "persona", params: { element_name: "my-persona", input: { description: "Updated description" } } }',
  ],
  delete_element: [
    '{ operation: "delete_element", elementType: "memory", params: { element_name: "old-persona", deleteData: true } }',
  ],
  // clear, execute_agent, get_execution_state, record_execution_step, complete_execution,
  // continue_execution, abort_execution, get_gathered_data, prepare_handoff, resume_from_handoff:
  // All migrated to INTROSPECTION_ONLY_SCHEMAS in OperationSchema.ts (Issue #594)
};

// ============================================================================
// IntrospectionResolver Class
// ============================================================================

/**
 * Resolver for introspection queries.
 * Provides self-documentation capabilities for MCP-AQL operations.
 */
export class IntrospectionResolver {
  /**
   * Execute an introspection query
   *
   * @param params - Introspection parameters
   * @param params.query - What to introspect: 'operations', 'types', 'format', or 'categories'
   * @param params.name - Optional: specific operation or type name
   * @returns IntrospectionResult with requested information
   */
  static resolve(params: Record<string, unknown>): IntrospectionResult {
    const query = (params.query as string) || 'operations';
    const name = params.name as string | undefined;

    switch (query) {
      case 'operations':
        if (name) {
          return { operation: this.getOperationDetails(name) };
        }
        return { operations: this.listOperations() };

      case 'types':
        if (name) {
          return { type: this.getTypeDetails(name) };
        }
        return { types: this.listTypes() };

      case 'format':
        return { formatSpec: this.getFormatSpec(name) };

      // Issue #631: Category discovery — format rules + guidance for live data
      case 'categories':
        return { categories: this.getCategoryInfo() };

      default:
        // Return empty result for unknown query types
        return {};
    }
  }

  /**
   * List all available operations
   *
   * For schema-driven operations, uses description from OperationSchema.
   * For legacy operations, uses description from OPERATION_ROUTES.
   *
   * @see Issue #254 - Single source of truth from schema
   */
  private static listOperations(): OperationInfo[] {
    const operations: OperationInfo[] = [];

    // Include all operations from OPERATION_ROUTES
    for (const [opName, route] of Object.entries(OPERATION_ROUTES)) {
      // Prefer schema description from any schema (dispatch-driven or introspection-only)
      const schema = getAnyOperationSchema(opName);
      operations.push({
        name: opName,
        endpoint: route.endpoint,
        description: schema?.description || route.description || `${opName} operation`,
      });
    }

    // Add introspect operation (schema-driven but not in OPERATION_ROUTES)
    const introspectSchema = getOperationSchema('introspect');
    operations.push({
      name: 'introspect',
      endpoint: 'READ',
      description: introspectSchema?.description || 'Query available operations and types (this operation)',
    });

    // Sort by endpoint then name for consistent ordering
    return operations.sort((a, b) => {
      const endpointOrder: Record<string, number> = { CREATE: 0, READ: 1, UPDATE: 2, DELETE: 3, EXECUTE: 4 };
      const endpointDiff = (endpointOrder[a.endpoint] ?? 5) - (endpointOrder[b.endpoint] ?? 5);
      if (endpointDiff !== 0) return endpointDiff;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Get detailed information about a specific operation
   *
   * For schema-driven operations, reads metadata from OperationSchema.
   * For legacy operations, uses fallback OPERATION_PARAMETERS/OPERATION_EXAMPLES.
   *
   * @see Issue #254 - Auto-generate introspection from schema
   */
  private static getOperationDetails(name: string): OperationDetails | null {
    // Check schema first — includes both dispatch-driven and introspection-only schemas
    const schema = getAnyOperationSchema(name);
    if (schema) {
      return this.getSchemaOperationDetails(name, schema);
    }

    // Legacy fallback for non-schema operations
    const route = OPERATION_ROUTES[name];
    if (!route) {
      return null;
    }

    return {
      name,
      endpoint: route.endpoint,
      mcpTool: `mcp_aql_${route.endpoint.toLowerCase()}`,
      description: route.description || `${name} operation`,
      permissions: PermissionGuard.getPermissions(route.endpoint as CRUDEndpoint),
      parameters: OPERATION_PARAMETERS[name] || [],
      returns: this.getReturnType(name),
      examples: OPERATION_EXAMPLES[name] || [],
      ...(route.aliases?.length ? { aliases: route.aliases } : {}),
    };
  }

  /**
   * Get operation details from OperationSchema (dispatch-driven or introspection-only)
   *
   * @see Issue #254 - Single source of truth from schema
   * @see Issue #594 - Introspection-only schemas for all operations
   */
  private static getSchemaOperationDetails(name: string, schema?: OperationDef): OperationDetails | null {
    const resolvedSchema = schema ?? getAnyOperationSchema(name);
    if (!resolvedSchema) {
      return null;
    }

    // Convert schema returns to TypeInfo, with fallback
    const returns: TypeInfo = resolvedSchema.returns
      ? { name: resolvedSchema.returns.name, kind: resolvedSchema.returns.kind, description: resolvedSchema.returns.description }
      : { name: 'OperationResult', kind: 'union', description: 'Success with data or failure with error' };

    const route = OPERATION_ROUTES[name];
    return {
      name,
      endpoint: resolvedSchema.endpoint,
      mcpTool: `mcp_aql_${resolvedSchema.endpoint.toLowerCase()}`,
      description: resolvedSchema.description,
      permissions: PermissionGuard.getPermissions(resolvedSchema.endpoint as CRUDEndpoint),
      parameters: schemaToParameterInfo(resolvedSchema.params),
      returns,
      examples: resolvedSchema.examples || [],
      ...(route?.aliases?.length ? { aliases: route.aliases } : {}),
    };
  }

  /**
   * Get the return type for a legacy (non-schema) operation.
   * Schema-driven and introspection-only operations get return types from their schema definitions.
   */
  private static getReturnType(operation: string): TypeInfo {
    // Operations migrated to schemas (Issue #594) are handled by getSchemaOperationDetails()
    // This fallback only applies to the few remaining non-schema operations
    const returnTypes: Record<string, TypeInfo> = {
      search_elements: { name: 'SearchResult', kind: 'object', description: 'Structured JSON: { items: [{ type, element_name, description, matchedIn }], pagination, sorting, query }' },
      query_elements: { name: 'QueryResult', kind: 'object', description: 'Structured JSON: { items: [{ name, description, type, version, tags }], pagination, sorting, element_type }. Or AggregationResult: { count, element_type, groups? } when aggregate param is used.' },
    };

    return returnTypes[operation] || {
      name: 'OperationResult',
      kind: 'union',
      description: 'Success with data or failure with error',
    };
  }

  /**
   * List all available types
   */
  private static listTypes(): TypeInfo[] {
    return Object.entries(TYPE_DEFINITIONS).map(([name, def]) => ({
      name,
      kind: def.kind,
      description: def.description,
    }));
  }

  /**
   * Get detailed information about a specific type
   */
  private static getTypeDetails(name: string): TypeDetails | null {
    return TYPE_DEFINITIONS[name] || null;
  }

  /**
   * Get format specification for an element type.
   * If name is provided, returns a single spec (or null for unknown types).
   * If name is omitted, returns all specs as an overview.
   *
   * @see Issue #715 - Proactive LLM guidance for element creation
   */
  private static getFormatSpec(name?: string): FormatSpec | FormatSpec[] | null {
    if (!name) {
      // Return all format specs as an overview
      return Object.values(FORMAT_SPECS);
    }

    // Normalize: handle plurals, case, whitespace
    const normalized = normalizeTypeName(name);
    if (!normalized) {
      return null;
    }

    return FORMAT_SPECS[normalized] || null;
  }

  /**
   * Issue #631: Category discovery info — format rules, allowed aggregation fields,
   * and guidance for discovering existing categories via query_elements.
   * IntrospectionResolver is stateless (no portfolio access), so live category data
   * must be fetched via query_elements with aggregate: { group_by: "category" }.
   */
  private static getCategoryInfo(): Record<string, unknown> {
    return {
      formatRules: {
        pattern: VALIDATION_PATTERNS.SAFE_CATEGORY.source,
        description: 'Category names must start with a letter, contain only letters, digits, hyphens, and underscores, and be 1-21 characters long.',
        examples: ['development', 'code-analysis', 'security', 'business', 'communication'],
      },
      supportedTypes: ['persona', 'skill', 'template', 'memory'],
      allowedGroupByFields: getAllowedGroupByFields(),
      discovery: {
        description: 'To discover existing categories in your portfolio, use query_elements with group_by aggregation.',
        examples: [
          '{ operation: "query_elements", element_type: "skill", params: { aggregate: { count: true, group_by: "category" } } }',
          '{ operation: "query_elements", element_type: "template", params: { aggregate: { count: true, group_by: "category" } } }',
          '{ operation: "query_elements", element_type: "skill", params: { filters: { category: "security" } } }',
        ],
      },
    };
  }

  /**
   * Get operations grouped by endpoint
   * Utility method for documentation generation
   */
  static getOperationsByEndpoint(): Record<CRUDEndpoint, OperationInfo[]> {
    const grouped: Record<CRUDEndpoint, OperationInfo[]> = {
      CREATE: [],
      READ: [],
      UPDATE: [],
      DELETE: [],
      EXECUTE: [],
    };

    for (const op of this.listOperations()) {
      const endpoint = op.endpoint as CRUDEndpoint;
      if (grouped[endpoint]) {
        grouped[endpoint].push(op);
      }
    }

    return grouped;
  }

  /**
   * Generate a compact summary for token-efficient responses
   */
  static getSummary(): string {
    const opsByEndpoint = this.getOperationsByEndpoint();
    const lines: string[] = ['MCP-AQL Operations:'];

    for (const [endpoint, ops] of Object.entries(opsByEndpoint)) {
      const opNames = ops.map(o => o.name).join(', ');
      lines.push(`  ${endpoint}: ${opNames}`);
    }

    lines.push(`\nTypes: ${Object.keys(TYPE_DEFINITIONS).join(', ')}`);
    lines.push('\nUse introspect with name parameter for details.');

    return lines.join('\n');
  }
}
