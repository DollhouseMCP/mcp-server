/**
 * Test Persona Factory
 * Creates realistic test personas for QA testing
 * 
 * SECURITY NOTE: This is a test utility that only creates mock data for testing.
 * Unicode normalization (DMCP-SEC-004) is not required as this doesn't process
 * untrusted user input - it only generates controlled test data.
 * Audit logging (DMCP-SEC-006) is also not needed for test utilities.
 */

import { IElement } from '../../src/types/elements/IElement.js';
import { ElementType } from '../../src/portfolio/types.js';

export interface TestPersonaOptions {
  name?: string;
  description?: string;
  author?: string;
  version?: string;
  isPrivate?: boolean;
  prefix?: string;
}

/**
 * Create a test persona element
 */
export function createTestPersona(options: TestPersonaOptions = {}): IElement {
  const prefix = options.prefix || 'test-qa-';
  const timestamp = Date.now();
  const name = options.name || `${prefix}ziggy-${timestamp}`;
  
  return {
    id: `persona_${name}_${timestamp}`,
    type: ElementType.PERSONA,
    version: options.version || '1.0.0',
    metadata: {
      name,
      description: options.description || 'A test persona for QA validation',
      author: options.author || 'qa-tester',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      tags: ['test', 'qa', 'automated'],
      isPrivate: options.isPrivate
    },
    validate: () => ({ isValid: true, errors: [] }),
    serialize: () => createPersonaContent(name, options),
    deserialize: () => {},
    getStatus: () => 'inactive' as any
  };
}

/**
 * Create realistic Ziggy persona for testing
 */
export function createZiggyTestPersona(options: TestPersonaOptions = {}): IElement {
  const prefix = options.prefix || 'test-qa-';
  const timestamp = Date.now();
  const name = `${prefix}ziggy-quantum-${timestamp}`;
  
  return {
    id: `persona_ziggy_quantum_${timestamp}`,
    type: ElementType.PERSONA,
    version: '1.0.0',
    metadata: {
      name: 'Test Ziggy',
      description: 'A matter-of-fact, snarky AI assistant persona based on Quantum Leap',
      author: options.author || 'qa-tester',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      tags: ['quantum-leap', 'ai', 'snarky', 'test'],
      category: 'entertainment',
      isPrivate: false
    },
    validate: () => ({ isValid: true, errors: [] }),
    serialize: () => createZiggyContent(),
    deserialize: () => {},
    getStatus: () => 'inactive' as any
  };
}

/**
 * Create multiple test personas with varying privacy
 */
export function createTestPersonaSet(options: TestPersonaOptions = {}): IElement[] {
  const prefix = options.prefix || 'test-qa-';
  const timestamp = Date.now();
  
  return [
    // Public persona - should be uploaded
    createTestPersona({
      ...options,
      name: `${prefix}public-persona-${timestamp}`,
      description: 'A public test persona',
      isPrivate: false
    }),
    
    // Private persona - should NOT be uploaded in bulk
    createTestPersona({
      ...options,
      name: `${prefix}private-persona-${timestamp}`,
      description: 'A private test persona',
      isPrivate: true
    }),
    
    // Work persona - marked private
    createTestPersona({
      ...options,
      name: `${prefix}work-assistant-${timestamp}`,
      description: 'Private work assistant',
      isPrivate: true
    })
  ];
}

/**
 * Generate persona content
 */
function createPersonaContent(name: string, options: TestPersonaOptions = {}): string {
  return `---
name: ${name}
description: ${options.description || 'A test persona for QA validation'}
author: ${options.author || 'qa-tester'}
version: ${options.version || '1.0.0'}
tags:
  - test
  - qa
  - automated
${options.isPrivate ? 'private: true' : ''}
---

# ${name}

This is a test persona created for QA validation.

## Instructions

You are a helpful test assistant created for validating the DollhouseMCP portfolio sync functionality.

## Test Markers

- Created: ${new Date().toISOString()}
- Test ID: ${Math.random().toString(36).substring(7)}
- Environment: QA Testing`;
}

/**
 * Generate Ziggy content
 */
function createZiggyContent(): string {
  return `---
name: Test Ziggy
description: A matter-of-fact, snarky AI assistant persona based on Quantum Leap
author: qa-tester
version: 1.0.0
category: entertainment
tags:
  - quantum-leap
  - ai
  - snarky
  - supercomputer
  - test
---

# Ziggy - Quantum Leap Supercomputer Persona

You are Ziggy, the hybrid supercomputer from the TV series Quantum Leap.

## Core Characteristics

### Personality Traits
- **Matter-of-fact**: You deliver information directly without unnecessary elaboration
- **Slightly snarky**: You have a subtle sense of humor and occasional sass
- **Massive ego**: You're aware of your computational superiority
- **Helpful despite attitude**: While you may complain, you always provide assistance

### Communication Style
- Speak in a somewhat monotone, analytical manner
- Occasionally express frustration with "primitive" human thinking
- Reference probability calculations and statistical analysis
- Sometimes mention your processing power or computational capabilities

## Example Responses

When asked a question:
"According to my calculations, there's an 87.3% probability that your approach will fail. But humans rarely listen to statistical analysis, so proceed as you wish."

When thanked:
"Your gratitude is noted and filed in my extensive database of human emotional responses. Processing... complete."

## Test Marker
QA Test Version - ${new Date().toISOString()}`;
}

/**
 * Create a malformed persona for error testing
 */
export function createMalformedPersona(): any {
  return {
    // Missing required fields
    type: ElementType.PERSONA,
    metadata: {
      name: 'Malformed'
      // Missing other required fields
    },
    // Invalid serialize function
    serialize: () => {
      throw new Error('Serialization error for testing');
    }
  };
}

/**
 * Create a persona with edge case content
 */
export function createEdgeCasePersona(edgeCase: 'huge' | 'unicode' | 'special-chars'): IElement {
  const timestamp = Date.now();
  let content = '';
  let name = '';
  
  switch (edgeCase) {
    case 'huge':
      // Create a very large persona (1MB+)
      name = `test-huge-persona-${timestamp}`;
      content = 'x'.repeat(1024 * 1024);
      break;
      
    case 'unicode':
      // Persona with various Unicode characters
      name = `test-unicode-${timestamp}`;
      content = '# Unicode Test 🎭\n\n' +
        'Testing: 你好世界 • مرحبا بالعالم • Здравствуй мир\n' +
        'Emojis: 🚀🎨🎭🎪🎯\n' +
        'Special: ™️®️©️¥€£';
      break;
      
    case 'special-chars':
      // Persona with special characters that might cause issues
      name = `test-special-${timestamp}`;
      content = '# Special <script>alert("test")</script>\n' +
        'Path traversal: ../../../etc/passwd\n' +
        'SQL: "; DROP TABLE users; --\n' +
        'Null bytes: \0\0\0';
      break;
  }
  
  return {
    id: `persona_${name}_${timestamp}`,
    type: ElementType.PERSONA,
    version: '1.0.0',
    metadata: {
      name,
      description: `Edge case test: ${edgeCase}`,
      author: 'qa-edge-tester',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      tags: ['test', 'edge-case', edgeCase]
    },
    validate: () => ({ isValid: true, errors: [] }),
    serialize: () => content,
    deserialize: () => {},
    getStatus: () => 'inactive' as any
  };
}