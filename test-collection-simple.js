#!/usr/bin/env node

import { GitHubClient, MarketplaceBrowser } from './dist/collection/index.js';
import { APICache } from './dist/cache/APICache.js';

async function testCollectionBrowsing() {
  console.log('Testing DollhouseMCP Collection Browsing...\n');
  
  const apiCache = new APICache();
  const rateLimitTracker = new Map();
  const githubClient = new GitHubClient(apiCache, rateLimitTracker);
  const browser = new MarketplaceBrowser(githubClient);
  
  try {
    // Test 1: Browse top-level sections
    console.log('1. Testing browse top-level:');
    const result = await browser.browseCollection();
    console.log('Sections found:', result.sections?.length || 0);
    result.sections?.forEach(s => console.log(`  - ${s.name}`));
    console.log('\n');
    
    // Test 2: Browse library section
    console.log('2. Testing browse library:');
    const library = await browser.browseCollection('library');
    console.log('Content types found:', library.categories?.length || 0);
    library.categories?.forEach(c => console.log(`  - ${c.name}`));
    console.log('\n');
    
    // Format and display the results
    const formatted = browser.formatBrowseResults(
      library.items || [], 
      library.categories || [], 
      'library', 
      undefined, 
      ''
    );
    console.log('Formatted output:');
    console.log(formatted);
    
  } catch (error) {
    console.error('Error during testing:', error.message);
    if (error.response) {
      console.error('API Response:', error.response);
    }
  }
}

testCollectionBrowsing();