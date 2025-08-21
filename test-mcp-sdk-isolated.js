#!/usr/bin/env node

/**
 * Ultra-minimal MCP SDK test to isolate tool execution timeout
 * This bypasses all application logic to test pure MCP SDK behavior
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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
  return {
    tools: [{
      name: "instant_test",
      description: "Returns immediately",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }]
  };
});

// Add instant-response tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.error(`DEBUG: CallToolRequest received for ${request.params.name} at ${new Date().toISOString()}`);
  
  if (request.params.name === "instant_test") {
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
  
  throw new Error(`Unknown tool: ${request.params.name}`);
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