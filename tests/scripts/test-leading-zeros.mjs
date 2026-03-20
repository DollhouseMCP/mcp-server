#!/usr/bin/env node

import { normalizeVersion } from './dist/elements/BaseElement.js';

const testCases = [
  '01',
  '01.02',
  '01.02.03',
  '001.002.003',
  '0.0.1',
  '00.00.01',
  '1.01.0',
  '1.0.01'
];

console.log('Testing version normalization with leading zeros:\n');

testCases.forEach(version => {
  const normalized = normalizeVersion(version);
  console.log(`"${version}" → "${normalized}"`);
});

console.log('\n---\nValidation test (does the regex accept these?):\n');

// Test if the validation regex accepts leading zeros
const flexibleVersionRegex = /^\d+(\.\d+)?(\.\d+)?(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;

testCases.forEach(version => {
  const isValid = flexibleVersionRegex.test(version);
  console.log(`"${version}" - ${isValid ? '✅ Valid' : '❌ Invalid'}`);
});
