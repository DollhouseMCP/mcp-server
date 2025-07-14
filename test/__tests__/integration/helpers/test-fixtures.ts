/**
 * Test fixtures for integration tests
 */

import { Persona, PersonaMetadata } from '../../../../src/types/persona.js';

export const TEST_PERSONAS = {
  creative: {
    metadata: {
      name: 'Creative Writer',
      description: 'A creative writing assistant',
      category: 'creative',
      version: '1.0',
      author: 'test-user',
      unique_id: 'creative-writer_20250101-120000_test-user',
      triggers: ['creative', 'writing', 'story'],
      created_date: '2025-01-01T12:00:00Z'
    } as PersonaMetadata,
    content: 'You are a creative writing assistant focused on storytelling and narrative development. Help users craft compelling stories, develop characters, and create engaging narratives.',
    filename: 'creative-writer.md',
    unique_id: 'creative-writer_20250101-120000_test-user'
  } as Persona,
  
  technical: {
    metadata: {
      name: 'Technical Assistant',
      description: 'A technical documentation helper',
      category: 'professional',
      version: '1.0',
      author: 'test-user',
      unique_id: 'technical-assistant_20250101-120000_test-user',
      triggers: ['technical', 'documentation', 'api'],
      created_date: '2025-01-01T12:00:00Z'
    } as PersonaMetadata,
    content: 'You are a technical documentation assistant specializing in API documentation, code comments, and technical writing. Help users create clear, comprehensive technical documentation.',
    filename: 'technical-assistant.md',
    unique_id: 'technical-assistant_20250101-120000_test-user'
  } as Persona
};

export const MOCK_GITHUB_RESPONSES = {
  marketplaceContents: {
    creative: [
      {
        name: 'storyteller.md',
        path: 'creative/storyteller.md',
        type: 'file',
        size: 1234,
        sha: 'abc123'
      },
      {
        name: 'poet.md',
        path: 'creative/poet.md',
        type: 'file',
        size: 567,
        sha: 'def456'
      }
    ]
  },
  
  personaFile: {
    content: Buffer.from(`---
name: Storyteller
description: Master storyteller for engaging narratives
category: creative
author: marketplace
version: 1.0
---

You are a master storyteller.`).toString('base64'),
    encoding: 'base64'
  }
};

export function createTestPersona(overrides: Partial<Persona> = {}): Persona {
  const base = { ...TEST_PERSONAS.creative };
  return {
    ...base,
    ...overrides,
    metadata: {
      ...base.metadata,
      ...(overrides.metadata || {})
    }
  };
}

export function createPersonaFileContent(persona: Persona): string {
  const frontmatter = Object.entries(persona.metadata)
    .filter(([key]) => key !== 'unique_id') // Don't include in file
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${key}: [${value.join(', ')}]`;
      }
      return `${key}: ${value}`;
    })
    .join('\n');
    
  return `---
${frontmatter}
---

${persona.content}`;
}