#!/usr/bin/env node

import { DollhouseMCPServer } from './dist/index.js';

async function testCollectionBrowsing() {
  console.log('Testing DollhouseMCP Collection Browsing...\n');
  
  const server = new DollhouseMCPServer();
  
  try {
    // Test 1: Browse top-level sections
    console.log('1. Testing browse_collection (no parameters):');
    const sections = await server.browseCollection();
    console.log(sections.content[0].text);
    console.log('\n---\n');
    
    // Test 2: Browse library section
    console.log('2. Testing browse_collection "library":');
    const library = await server.browseCollection('library');
    console.log(library.content[0].text);
    console.log('\n---\n');
    
    // Test 3: Browse specific content type
    console.log('3. Testing browse_collection "library" "personas":');
    const personas = await server.browseCollection('library', 'personas');
    console.log(personas.content[0].text);
    
  } catch (error) {
    console.error('Error during testing:', error);
  }
}

testCollectionBrowsing();