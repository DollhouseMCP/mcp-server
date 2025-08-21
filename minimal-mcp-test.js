#!/usr/bin/env node

/**
 * Ultra-minimal MCP test to isolate the exact point of failure
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Create a minimal server that only responds to one tool
const server = new Server({
  name: "minimal-test-server",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {}
  }
});

// Add only a minimal tool
server.setRequestHandler("tools/list", async () => {
  console.error("DEBUG: tools/list called");
  return {
    tools: [{
      name: "test_tool",
      description: "Minimal test tool",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }]
  };
});

server.setRequestHandler("tools/call", async (request) => {
  console.error(`DEBUG: tools/call received for ${request.params.name}`);
  
  if (request.params.name === "test_tool") {
    console.error("DEBUG: Executing test_tool");
    return {
      content: [
        {
          type: "text",
          text: "Test tool executed successfully!"
        }
      ]
    };
  }
  
  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Add proper error handling
server.onerror = (error) => {
  console.error("Server error:", error);
};

// Start server
console.error("Starting minimal MCP server...");
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Minimal MCP server ready");