#!/usr/bin/env node

import { spawn } from 'child_process';

const docker = spawn('docker', [
  'run',
  '--rm',
  '-i', 
  'claude-mcp-test-env:latest',
  'node',
  '/app/dollhousemcp/dist/index.js'
]);

let responseBuffer = '';

docker.stdout.on('data', (data) => {
  responseBuffer += data.toString();
  const lines = responseBuffer.split('\n');
  responseBuffer = lines.pop() || '';
  
  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        if (response.id === 2 && response.result?.tools) {
          console.log('\n📋 Available MCP Tools:\n');
          const tools = response.result.tools;
          
          // Group tools by category
          const portfolioTools = tools.filter(t => t.name.includes('portfolio') || t.name.includes('sync'));
          const collectionTools = tools.filter(t => t.name.includes('collection') || t.name.includes('install') || t.name.includes('submit'));
          const elementTools = tools.filter(t => t.name.includes('element'));
          const otherTools = tools.filter(t => 
            !t.name.includes('portfolio') && 
            !t.name.includes('sync') &&
            !t.name.includes('collection') &&
            !t.name.includes('install') &&
            !t.name.includes('submit') &&
            !t.name.includes('element')
          );
          
          console.log('🗂️ Portfolio Tools:');
          portfolioTools.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}`));
          
          console.log('\n📦 Collection Tools:');
          collectionTools.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}`));
          
          console.log('\n🔧 Element Tools:');
          elementTools.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}`));
          
          console.log('\n📌 Other Tools:');
          otherTools.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}`));
          
          console.log(`\n✅ Total tools: ${tools.length}`);
          docker.kill();
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }
});

docker.stderr.on('data', () => {
  // Suppress stderr
});

docker.on('close', () => {
  process.exit(0);
});

// Send initialization and list request
const messages = [
  {"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"0.1.0","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1},
  {"jsonrpc":"2.0","method":"tools/list","params":{},"id":2}
];

messages.forEach(msg => {
  docker.stdin.write(JSON.stringify(msg) + '\n');
});