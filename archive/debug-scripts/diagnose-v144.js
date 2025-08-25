#!/usr/bin/env node

console.log('=== DollhouseMCP v1.4.4 Diagnostic Tool ===\n');

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

async function diagnose() {
  // 1. Check NPM installation
  console.log('1. Checking NPM installation...');
  try {
    const npmList = spawn('npm', ['list', '-g', '@dollhousemcp/mcp-server'], {
      stdio: 'pipe'
    });
    
    let output = '';
    npmList.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    await new Promise((resolve) => npmList.on('close', resolve));
    console.log(output);
  } catch (error) {
    console.error('Failed to check NPM installation:', error);
  }

  // 2. Check portfolio directory
  console.log('\n2. Checking portfolio directory...');
  const portfolioDir = path.join(homedir(), '.dollhouse', 'portfolio');
  try {
    const exists = await fs.access(portfolioDir).then(() => true).catch(() => false);
    console.log(`Portfolio directory exists: ${exists}`);
    
    if (exists) {
      const dirs = await fs.readdir(portfolioDir);
      console.log('Directories found:', dirs);
      
      // Check for singular vs plural
      const hasSingular = dirs.some(d => ['persona', 'skill', 'template', 'agent', 'memory', 'ensemble'].includes(d));
      const hasPlural = dirs.some(d => ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'].includes(d));
      
      if (hasSingular) {
        console.log('⚠️  WARNING: Found singular directories (v1.4.2 style)');
      }
      if (hasPlural) {
        console.log('✅ Found plural directories (v1.4.3+ style)');
      }
    }
  } catch (error) {
    console.error('Error checking portfolio:', error);
  }

  // 3. Try to run the server directly
  console.log('\n3. Testing direct server execution...');
  const serverPath = '/opt/homebrew/lib/node_modules/@dollhousemcp/mcp-server/dist/index.js';
  
  console.log(`Attempting to run: node ${serverPath}`);
  
  const server = spawn('node', [serverPath], {
    stdio: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEBUG: '*'
    }
  });

  let serverOutput = '';
  let serverError = '';
  
  server.stdout.on('data', (data) => {
    serverOutput += data.toString();
  });
  
  server.stderr.on('data', (data) => {
    serverError += data.toString();
  });

  // Give it 3 seconds to start
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Kill the server
  server.kill();
  
  console.log('\nServer stdout:');
  console.log(serverOutput || '(no output)');
  
  console.log('\nServer stderr:');
  console.log(serverError || '(no errors)');

  // 4. Check for common issues
  console.log('\n4. Common issue checks...');
  
  // Check if jsdom is available
  try {
    require.resolve('jsdom');
    console.log('✅ jsdom is available');
  } catch {
    console.log('❌ jsdom is NOT available (this might be the issue)');
  }
  
  // Check if DOMPurify is available
  try {
    require.resolve('dompurify');
    console.log('✅ dompurify is available');
  } catch {
    console.log('❌ dompurify is NOT available (this might be the issue)');
  }

  console.log('\n=== Diagnostic Complete ===');
  console.log('\nRecommendations:');
  console.log('1. If jsdom/dompurify are missing, try: npm install -g jsdom dompurify');
  console.log('2. If singular directories exist, manually rename them to plural');
  console.log('3. Check the server stderr output above for specific errors');
}

diagnose().catch(console.error);