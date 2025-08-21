#!/usr/bin/env node

/**
 * Ultra-minimal MCP SDK test to isolate tool execution timeout
 * This bypasses all application logic to test pure MCP SDK behavior
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
// SECURITY FIX (DMCP-SEC-004): Import UnicodeValidator for input normalization
// Prevents homograph attacks, direction override, and mixed script attacks
import { UnicodeValidator } from "./src/security/validators/unicodeValidator.js";
// ACCURACY FIX (SECURE-3): Import test configuration for timeout management
import { CONFIG } from "./test-config.js";

console.error("DEBUG: Creating minimal MCP server for timeout isolation");

// Create absolute minimum server
const server = new Server({
  name: "timeout-test-server",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {}
  }
});

// Add minimal tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error("DEBUG: ListToolsRequest received");
  // ACCURACY FIX (SECURE-3): Use existing tool for better isolation testing
  return {
    tools: [{
      name: "instant_test",
      description: "Returns immediately for timeout isolation testing",
      inputSchema: {
        type: "object",
        properties: {
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (for testing)",
            default: CONFIG.timeouts.tool_call
          }
        }
      }
    }]
  };
});

// Add instant-response tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // SECURITY FIX (DMCP-SEC-004): Unicode normalization for user input
  // Previously: Direct usage of tool name without validation
  // Now: UnicodeValidator.normalize() prevents homograph attacks and direction override
  const normalizedToolName = UnicodeValidator.normalize(request.params.name).normalizedContent;
  
  console.error(`DEBUG: CallToolRequest received for ${normalizedToolName} at ${new Date().toISOString()}`);
  
  if (normalizedToolName === "instant_test") {
    console.error("DEBUG: Returning instant response");
    // Return immediately with no async operations
    return {
      content: [
        {
          type: "text",
          text: "Instant response from minimal server!"
        }
      ]
    };
  }
  
  throw new Error(`Unknown tool: ${normalizedToolName}`);
});

// Add error handler
server.onerror = (error) => {
  console.error("DEBUG: Server error:", error);
};

console.error("DEBUG: Starting minimal server transport...");
const transport = new StdioServerTransport();

try {
  await server.connect(transport);
  console.error("DEBUG: Minimal server connected successfully");
} catch (error) {
  console.error("DEBUG: Server connection failed:", error);
  process.exit(1);
}