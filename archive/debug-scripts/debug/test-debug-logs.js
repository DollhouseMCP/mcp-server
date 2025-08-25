#!/usr/bin/env node

/**
 * Quick test to verify DEBUG_LOG statements are working
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Testing DEBUG_LOG output...\n');

const server = spawn('node', [path.join(__dirname, '..', 'dist', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let output = '';

server.stdout.on('data', (data) => {
  process.stdout.write(`[STDOUT] ${data}`);
  output += data;
});

server.stderr.on('data', (data) => {
  process.stderr.write(`[STDERR] ${data}`);
  output += data;
});

server.on('error', (err) => {
  console.error('[ERROR]', err);
});

// Give it 2 seconds then kill it
setTimeout(() => {
  server.kill();
  
  console.log('\n\n=== DEBUG LOG SUMMARY ===');
  const debugLines = output.split('\n').filter(line => line.includes('[DEBUG'));
  console.log(`Found ${debugLines.length} DEBUG log lines:`);
  debugLines.forEach(line => console.log(line));
  
  if (debugLines.length === 0) {
    console.log('\nWARNING: No DEBUG logs found! Check implementation.');
  } else {
    console.log('\n✓ DEBUG logging is working');
  }
}, 2000);