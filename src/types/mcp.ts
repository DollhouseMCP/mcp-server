/**
 * Type definitions for MCP-related structures
 */

import { z } from 'zod';

// Re-export ErrorCode from MCP SDK
export { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Tool parameter schemas
export const ListPersonasArgsSchema = z.object({});

export const ActivatePersonaArgsSchema = z.object({
  identifier: z.string().describe("Persona name, filename, or unique ID")
});

export const GetActivePersonaArgsSchema = z.object({});

export const DeactivatePersonaArgsSchema = z.object({});

export const GetPersonaDetailsArgsSchema = z.object({
  identifier: z.string().describe("Persona name, filename, or unique ID")
});

export const ReloadPersonasArgsSchema = z.object({});

// Updated schema name from marketplace to collection for consistency (PR #280)
export const BrowseCollectionArgsSchema = z.object({
  category: z.string().optional().describe("Category to browse (creative, professional, etc.)")
});

// Updated schema name from marketplace to collection for consistency (PR #280)
export const SearchCollectionArgsSchema = z.object({
  query: z.string().describe("Search query")
});

// Updated schema name from marketplace to collection for consistency (PR #280)
export const GetCollectionContentArgsSchema = z.object({
  path: z.string().describe("Path to the content file in the collection repository")
});

// Updated schema name from InstallPersona to InstallContent for consistency (PR #280)
export const InstallContentArgsSchema = z.object({
  path: z.string().describe("Path to the content file in the collection repository")
});

// Updated schema name from SubmitPersona to SubmitContent for consistency (PR #280)
export const SubmitContentArgsSchema = z.object({
  content_name: z.string().describe("Name of the local content to submit")
});

export const SetUserIdentityArgsSchema = z.object({
  username: z.string().describe("Your username for persona attribution"),
  email: z.string().optional().describe("Your email address (optional)")
});

export const GetUserIdentityArgsSchema = z.object({});

export const ClearUserIdentityArgsSchema = z.object({});

export const CreatePersonaArgsSchema = z.object({
  name: z.string().describe("Name for the new persona"),
  description: z.string().describe("Brief description of the persona"),
  category: z.string().describe("Category (creative, professional, educational, gaming, personal)"),
  instructions: z.string().describe("The persona instructions/content")
});

export const EditPersonaArgsSchema = z.object({
  persona_name: z.string().describe("Name of the persona to edit"),
  field: z.string().describe("Field to edit (name, description, instructions, category, triggers, version)"),
  value: z.string().describe("New value for the field")
});

export const ValidatePersonaArgsSchema = z.object({
  persona_name: z.string().describe("Name of the persona to validate")
});

export const CheckForUpdatesArgsSchema = z.object({});

export const UpdateServerArgsSchema = z.object({
  createBackup: z.boolean().optional().describe("Whether to create a backup before updating (default: true)")
});

export const RollbackUpdateArgsSchema = z.object({
  force: z.boolean().optional().describe("Force rollback even if current version is working (default: false)")
});

export const GetServerStatusArgsSchema = z.object({});

export const ConfigureIndicatorArgsSchema = z.object({
  enabled: z.boolean().optional().describe("Whether to show indicators"),
  style: z.enum(['full', 'minimal', 'compact', 'custom']).optional().describe("Display style"),
  customFormat: z.string().optional().describe("Custom format string"),
  showEmoji: z.boolean().optional().describe("Show emoji in indicator"),
  showName: z.boolean().optional().describe("Show persona name"),
  showVersion: z.boolean().optional().describe("Show version"),
  showAuthor: z.boolean().optional().describe("Show author"),
  showCategory: z.boolean().optional().describe("Show category"),
  separator: z.string().optional().describe("Separator after indicator"),
  emoji: z.string().optional().describe("Custom emoji to use"),
  bracketStyle: z.enum(['square', 'round', 'curly', 'angle', 'none']).optional().describe("Bracket style")
});

export const GetIndicatorConfigArgsSchema = z.object({});