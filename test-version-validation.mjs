#!/usr/bin/env node

// Test version validation fix for Issue #935
import { BaseElement } from './dist/elements/BaseElement.js';

class TestElement extends BaseElement {
  constructor(version) {
    super('skills', {
      name: 'test',
      description: 'test'
    });
    this.version = version;
  }
}

const testCases = [
  // Should PASS with new flexible regex
  { version: '1', expected: true },
  { version: '1.0', expected: true },
  { version: '1.1', expected: true },
  { version: '2.0', expected: true },
  { version: '1.0.0', expected: true },
  { version: '2.1.0', expected: true },
  { version: '1.0.0-beta', expected: true },
  { version: '1.0.0-alpha.1', expected: true },
  { version: '1.0.0+build123', expected: true },
  { version: '1.0-rc.1', expected: true },
  
  // Should FAIL - invalid formats
  { version: 'v1.0', expected: false },
  { version: 'version1', expected: false },
  { version: '1.a', expected: false },
  { version: '', expected: false },
  { version: 'beta', expected: false }
];

console.log('Testing flexible version validation (Issue #935 fix):\n');

let passed = 0;
let failed = 0;

testCases.forEach(test => {
  const element = new TestElement(test.version);
  const result = element.validate();
  const hasVersionError = result.errors?.some(e => e.code === 'INVALID_VERSION_FORMAT');
  const isValid = !hasVersionError;
  
  if (isValid === test.expected) {
    console.log(`✅ "${test.version}" - ${isValid ? 'Valid' : 'Invalid'} (as expected)`);
    passed++;
  } else {
    console.log(`❌ "${test.version}" - ${isValid ? 'Valid' : 'Invalid'} (expected ${test.expected ? 'Valid' : 'Invalid'})`);
    failed++;
  }
});

console.log(`\n${passed}/${testCases.length} tests passed`);
if (failed > 0) {
  console.log(`${failed} tests failed`);
  process.exit(1);
}

console.log('\n✅ All version validation tests passed! Skills with versions like "1.1" will now activate.');
