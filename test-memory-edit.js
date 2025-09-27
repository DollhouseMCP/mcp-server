#!/usr/bin/env node

// Test script for memory edit fix
const testEntry = {
  id: "test_entry_1",
  timestamp: "2025-09-22T10:00:00Z",  // String timestamp to trigger the bug
  content: "Updated test content",
  tags: ["test", "update"]
};

const editPayload = {
  name: "docker-claude-code-authentication-solution",
  type: "memory",
  field: "entries",
  value: [testEntry]
};

console.log("Testing memory edit with string timestamp...");
console.log("Edit payload:", JSON.stringify(editPayload, null, 2));

// The actual MCP call would be:
// mcp__dollhousemcp-production__edit_element with the above payload
console.log("\nTo test this fix, use the MCP tool:");
console.log("mcp__dollhousemcp-production__edit_element");
console.log("with parameters:", JSON.stringify(editPayload, null, 2));
