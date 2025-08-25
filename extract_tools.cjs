const fs = require('fs');
const content = fs.readFileSync('src/index.ts', 'utf8');

// Find all tool case statements in switch blocks
const toolPattern = /case\s+['"]([^'"]+)['"]/g;
const tools = new Set();
let match;
while ((match = toolPattern.exec(content)) !== null) {
  tools.add(match[1]);
}

// Sort and number them
const sortedTools = Array.from(tools).sort();
console.log(`Found ${sortedTools.length} MCP tools:\n`);
sortedTools.forEach((tool, i) => {
  console.log(`${i + 1}. ${tool}`);
});
