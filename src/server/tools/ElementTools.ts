/**
 * Element-related tool definitions and handlers
 * Provides generic tools that work with all element types
 */

import { ToolDefinition } from '../../handlers/types/ToolTypes.js';
import { ElementType } from '../../portfolio/types.js';
import type { ElementCRUDHandler } from '../../handlers/ElementCRUDHandler.js';

// Type-safe interfaces for all element tool arguments
interface ListElementsArgs {
  type: string;
  // Pagination options (Issue #38)
  page?: number;
  pageSize?: number;
  // Sorting options (Issue #38)
  sortBy?: 'name' | 'created' | 'modified' | 'version' | 'retention';
  sortOrder?: 'asc' | 'desc';
  // Filter options (Issue #38)
  nameContains?: string;
  tags?: string[];
  tagsAny?: string[];
  author?: string;
  createdAfter?: string;
  createdBefore?: string;
  status?: 'active' | 'inactive' | 'all';
}

interface ActivateElementArgs {
  name: string;
  type: string;
}

interface DeactivateElementArgs {
  name: string;
  type: string;
}

interface GetElementDetailsArgs {
  name: string;
  type: string;
}

interface GetActiveElementsArgs {
  type: string;
}

interface CreateElementArgs {
  name: string;
  description: string;
  type: string;
  content?: string;
  metadata?: Record<string, any>;
}

interface EditElementArgs {
  name: string;
  type: string;
  input: Record<string, unknown>;
}

interface ValidateElementArgs {
  name: string;
  type: string;
  strict?: boolean;
}

interface DeleteElementArgs {
  name: string;
  type: string;
  deleteData?: boolean;
}

interface RenderTemplateArgs {
  name: string;
  variables: Record<string, any>;
}

interface ReloadElementsArgs {
  type: string;
}

interface ExecuteAgentArgs {
  name: string;
  parameters: Record<string, any>;
}

interface RecordAgentStepArgs {
  agentName: string;
  stepDescription: string;
  outcome: "success" | "failure" | "partial";
  findings?: string;
  confidence?: number;
  nextActionHint?: string;
  riskScore?: number;
}

interface CompleteAgentGoalArgs {
  agentName: string;
  goalId?: string;
  outcome: "success" | "failure" | "partial";
  summary: string;
}

interface GetAgentStateArgs {
  agentName: string;
  includeDecisionHistory?: boolean;
  includeContext?: boolean;
}

interface ContinueAgentExecutionArgs {
  agentName: string;
  parameters?: Record<string, any>;
  previousStepResult?: string;
}

export function getElementTools(server: ElementCRUDHandler): Array<{ tool: ToolDefinition; handler: any }> {
  return [
    {
      tool: {
        name: "list_elements",
        description: "List all available elements of a specific type with optional pagination, filtering, and sorting",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "The element type to list",
              enum: Object.values(ElementType),
            },
            // Pagination parameters (Issue #38)
            page: {
              type: "number",
              description: "Page number (1-indexed). Default: 1",
              minimum: 1,
            },
            pageSize: {
              type: "number",
              description: "Number of items per page. Default: 25, max: 100",
              minimum: 1,
              maximum: 100,
            },
            // Sorting parameters (Issue #38)
            sortBy: {
              type: "string",
              description: "Field to sort by. Default: 'name'",
              enum: ["name", "created", "modified", "version", "retention"],
            },
            sortOrder: {
              type: "string",
              description: "Sort direction. Default: 'asc'",
              enum: ["asc", "desc"],
            },
            // Filter parameters (Issue #38)
            nameContains: {
              type: "string",
              description: "Filter by partial name match (case-insensitive)",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Filter by tags (AND logic - must have ALL tags)",
            },
            tagsAny: {
              type: "array",
              items: { type: "string" },
              description: "Filter by tags (OR logic - must have ANY tag)",
            },
            author: {
              type: "string",
              description: "Filter by author (exact match, case-insensitive)",
            },
            createdAfter: {
              type: "string",
              description: "Filter for elements created after this date (ISO 8601 format)",
            },
            createdBefore: {
              type: "string",
              description: "Filter for elements created before this date (ISO 8601 format)",
            },
            status: {
              type: "string",
              description: "Filter by element status",
              enum: ["active", "inactive", "all"],
            },
          },
          required: ["type"],
        },
      },
      handler: (args: ListElementsArgs) => server.listElements(args.type, {
        pagination: {
          page: args.page,
          pageSize: args.pageSize,
        },
        sort: {
          sortBy: args.sortBy,
          sortOrder: args.sortOrder,
        },
        filters: {
          nameContains: args.nameContains,
          tags: args.tags,
          tagsAny: args.tagsAny,
          author: args.author,
          createdAfter: args.createdAfter,
          createdBefore: args.createdBefore,
          status: args.status,
        },
      })
    },
    {
      tool: {
        name: "activate_element",
        description: "Activate a specific element by name",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name to activate",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
          },
          required: ["name", "type"],
        },
      },
      handler: (args: ActivateElementArgs) => server.activateElement(args.name, args.type)
    },
    {
      tool: {
        name: "get_active_elements",
        description: "Get information about currently active elements of a specific type",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "The element type to check",
              enum: Object.values(ElementType),
            },
          },
          required: ["type"],
        },
      },
      handler: (args: GetActiveElementsArgs) => server.getActiveElements(args.type)
    },
    {
      tool: {
        name: "deactivate_element",
        description: "Deactivate a specific element",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name to deactivate",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
          },
          required: ["name", "type"],
        },
      },
      handler: (args: DeactivateElementArgs) => server.deactivateElement(args.name, args.type)
    },
    {
      tool: {
        name: "get_element_details",
        description: "Get detailed information about a specific element",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name to get details for",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
          },
          required: ["name", "type"],
        },
      },
      handler: (args: GetElementDetailsArgs) => server.getElementDetails(args.name, args.type)
    },
    {
      tool: {
        name: "reload_elements",
        description: "Reload elements of a specific type from the filesystem",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "The element type to reload",
              enum: Object.values(ElementType),
            },
          },
          required: ["type"],
        },
      },
      handler: (args: ReloadElementsArgs) => server.reloadElements(args.type)
    },
    // Element-specific tools
    {
      tool: {
        name: "render_template",
        description: "Render a template element with provided variables",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The template name to render",
            },
            variables: {
              type: "object",
              description: "Variables to use in the template",
              additionalProperties: true,
            },
          },
          required: ["name", "variables"],
        },
      },
      handler: (args: RenderTemplateArgs) => server.renderTemplate(args.name, args.variables)
    },
    {
      tool: {
        name: "execute_agent",
        description: "Execute an agent with a goal. Activates configured elements and returns context for LLM-driven agentic loop. The agent configuration defines a goal template that is filled with provided parameters.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name of the agent to execute",
            },
            parameters: {
              type: "object",
              description: "Parameters for the agent goal template (e.g., {directory: \"src\"})",
              additionalProperties: true,
            },
          },
          required: ["name", "parameters"],
        },
      },
      handler: (args: ExecuteAgentArgs) => server.executeAgent(args.name, args.parameters)
    },
    // Generic element creation tool
    {
      tool: {
        name: "create_element",
        description: "Create a new element of any type",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
            description: {
              type: "string",
              description: "Element description",
            },
            content: {
              type: "string",
              description: "Element content (required for some types)",
            },
            metadata: {
              type: "object",
              description: "Additional metadata specific to element type",
              additionalProperties: true,
            },
          },
          required: ["name", "type", "description"],
        },
      },
      handler: (args: CreateElementArgs) => server.createElement(args)
    },
    // Generic element editing tool - GraphQL-aligned nested input
    {
      tool: {
        name: "edit_element",
        description: "Edit an existing element using nested input objects (deep-merged with existing)",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name to edit",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
            input: {
              type: "object",
              description: "Nested object with fields to update. Fields are deep-merged with existing element. Example: { description: 'New desc', metadata: { triggers: ['code'] } }",
              additionalProperties: true,
            },
          },
          required: ["name", "type", "input"],
        },
      },
      handler: (args: EditElementArgs) => server.editElement(args)
    },
    // Generic element validation tool
    {
      tool: {
        name: "validate_element",
        description: "Validate an element for correctness and best practices",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name to validate",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
            strict: {
              type: "boolean",
              description: "Whether to apply strict validation rules",
              default: false,
            },
          },
          required: ["name", "type"],
        },
      },
      handler: (args: ValidateElementArgs) => server.validateElement(args)
    },
    // Generic element deletion tool
    {
      tool: {
        name: "delete_element",
        description: "Delete an element and optionally its associated data files",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The element name to delete",
            },
            type: {
              type: "string",
              description: "The element type",
              enum: Object.values(ElementType),
            },
            deleteData: {
              type: "boolean",
              description: "Whether to delete associated data files (if not specified, will prompt)",
              default: undefined,
            },
          },
          required: ["name", "type"],
        },
      },
      handler: (args: DeleteElementArgs) => server.deleteElement(args)
    },
    // Agent execution loop tools
    {
      tool: {
        name: "record_agent_step",
        description: "Record a step in the agent's execution, including progress, findings, and outcome. Use this to document what the agent has done, what it learned, and whether the step succeeded. This creates an audit trail, enables resumption, and returns an autonomy directive indicating whether to continue or pause.",
        inputSchema: {
          type: "object",
          properties: {
            agentName: {
              type: "string",
              description: "Name of the agent executing this step",
            },
            stepDescription: {
              type: "string",
              description: "Brief description of what this step accomplished (e.g., 'Analyzed codebase for security issues', 'Generated test cases')",
            },
            outcome: {
              type: "string",
              enum: ["success", "failure", "partial"],
              description: "Outcome of this step: 'success' (completed as intended), 'failure' (could not complete), 'partial' (made progress but not finished)",
            },
            findings: {
              type: "string",
              description: "Detailed findings, results, or observations from this step. Include relevant data, insights, or context for future steps.",
            },
            confidence: {
              type: "number",
              description: "Confidence level in this step's outcome (0.0 to 1.0). Optional, defaults to 0.8",
              minimum: 0,
              maximum: 1,
            },
            nextActionHint: {
              type: "string",
              description: "Hint about the next planned action. Used for autonomy evaluation to determine if approval is needed before proceeding.",
            },
            riskScore: {
              type: "number",
              description: "Risk score for the next action (0-100). Used for autonomy evaluation against risk tolerance thresholds.",
              minimum: 0,
              maximum: 100,
            },
          },
          required: ["agentName", "stepDescription", "outcome"],
        },
      },
      handler: (args: RecordAgentStepArgs) => server.recordAgentStep(args)
    },
    {
      tool: {
        name: "complete_agent_goal",
        description: "Signal that the agent has completed its goal. This marks the goal as complete, updates decision outcomes, and calculates performance metrics. Use this when all success criteria have been met.",
        inputSchema: {
          type: "object",
          properties: {
            agentName: {
              type: "string",
              description: "Name of the agent completing its goal",
            },
            goalId: {
              type: "string",
              description: "Optional specific goal ID to complete. If omitted, completes the most recent in-progress goal.",
            },
            outcome: {
              type: "string",
              enum: ["success", "failure", "partial"],
              description: "Final outcome: 'success' (all criteria met), 'failure' (could not achieve goal), 'partial' (made progress but incomplete)",
            },
            summary: {
              type: "string",
              description: "Summary of what was accomplished, challenges faced, and any relevant context for future reference",
            },
          },
          required: ["agentName", "outcome", "summary"],
        },
      },
      handler: (args: CompleteAgentGoalArgs) => server.completeAgentGoal(args)
    },
    {
      tool: {
        name: "get_agent_state",
        description: "Query the current state of an agent, including active goals, decision history, progress, and execution context. Use this to understand what the agent has done and what remains to be completed.",
        inputSchema: {
          type: "object",
          properties: {
            agentName: {
              type: "string",
              description: "Name of the agent to query",
            },
            includeDecisionHistory: {
              type: "boolean",
              description: "Include full decision history in response. Default: false (only includes recent decisions)",
            },
            includeContext: {
              type: "boolean",
              description: "Include full execution context. Default: false (only includes summary)",
            },
          },
          required: ["agentName"],
        },
      },
      handler: (args: GetAgentStateArgs) => server.getAgentState(args)
    },
    {
      tool: {
        name: "continue_agent_execution",
        description: "Continue executing an agent from its current state. Use this to resume after interruption or start the next step in a multi-step workflow. Returns the agent's context including previous state, allowing the LLM to pick up where it left off.",
        inputSchema: {
          type: "object",
          properties: {
            agentName: {
              type: "string",
              description: "Name of the agent to continue",
            },
            parameters: {
              type: "object",
              description: "Optional parameters to update the execution context (e.g., new data, changed requirements)",
              additionalProperties: true,
            },
            previousStepResult: {
              type: "string",
              description: "Optional summary of the previous step's result to inform the next step",
            },
          },
          required: ["agentName"],
        },
      },
      handler: (args: ContinueAgentExecutionArgs) => server.continueAgentExecution(args)
    },
  ];
}
