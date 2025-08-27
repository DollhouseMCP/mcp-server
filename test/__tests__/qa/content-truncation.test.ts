/**
 * QA Test: Content Truncation Investigation
 * 
 * This test investigates where content is being truncated in the pipeline.
 * Based on reports that personas are cut off mid-sentence in saved files.
 */

import { jest } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PersonaLoader } from '../../../src/persona/PersonaLoader.js';
import { PersonaElement } from '../../../src/persona/PersonaElement.js';
import { Persona } from '../../../src/types/persona.js';
import { ElementType } from '../../../src/portfolio/types.js';

describe('Content Truncation Investigation', () => {
  let tempDir: string;
  let personaLoader: PersonaLoader;

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = path.join(process.cwd(), 'temp-test-' + Date.now());
    await fs.mkdir(tempDir, { recursive: true });
    personaLoader = new PersonaLoader(tempDir);
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Test Content at Various Sizes', () => {
    const generateContent = (sizeInKB: number): string => {
      const baseText = 'This is a test sentence that will be repeated to create content of specific sizes. ';
      const repeatCount = Math.ceil((sizeInKB * 1024) / baseText.length);
      let content = baseText.repeat(repeatCount);
      
      // Add a unique ending marker to detect truncation
      content += '\n\nEND_OF_CONTENT_MARKER_12345';
      
      return content;
    };

    const testContentSize = async (sizeInKB: number) => {
      const testContent = generateContent(sizeInKB);
      const expectedSize = testContent.length;
      
      console.log(`\n=== Testing ${sizeInKB}KB content (${expectedSize} chars) ===`);

      // Create a persona with the test content
      const persona: Persona = {
        metadata: {
          name: `Test Persona ${sizeInKB}KB`,
          description: `Testing ${sizeInKB}KB of content`,
          author: 'test-author',
          version: '1.0.0',
          triggers: [],
          category: 'test',
          age_rating: 'all',
          content_flags: [],
          ai_generated: false,
          generation_method: 'human',
          price: 'free',
          license: 'MIT',
          created_date: new Date().toISOString()
        },
        content: testContent,
        filename: `test-persona-${sizeInKB}kb.md`,
        unique_id: `test_persona_${sizeInKB}kb_${Date.now()}`
      };

      // Save the persona
      console.log(`  Saving persona - content size: ${persona.content.length} chars`);
      await personaLoader.savePersona(persona);

      // Read the file directly to check what was written
      const filePath = path.join(tempDir, persona.filename);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      console.log(`  File content size: ${fileContent.length} chars`);

      // Parse the file to extract content
      const lines = fileContent.split('\n');
      let inFrontmatter = false;
      let contentStartIndex = -1;
      
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '---') {
          if (!inFrontmatter) {
            inFrontmatter = true;
          } else {
            contentStartIndex = i + 1;
            break;
          }
        }
      }

      if (contentStartIndex >= 0) {
        const extractedContent = lines.slice(contentStartIndex).join('\n').trim();
        console.log(`  Extracted content size: ${extractedContent.length} chars`);
        
        // Check if content ends with our marker
        const hasEndMarker = extractedContent.endsWith('END_OF_CONTENT_MARKER_12345');
        console.log(`  Has end marker: ${hasEndMarker}`);
        
        if (!hasEndMarker) {
          console.log(`  Last 100 chars: "${extractedContent.substring(extractedContent.length - 100)}"`);
        }

        // Load the persona back
        const loadedPersona = await personaLoader.loadPersona(
          persona.filename,
          () => 'test-user'
        );
        
        if (loadedPersona) {
          console.log(`  Loaded content size: ${loadedPersona.content.length} chars`);
          const loadedHasMarker = loadedPersona.content.endsWith('END_OF_CONTENT_MARKER_12345');
          console.log(`  Loaded has end marker: ${loadedHasMarker}`);
          
          if (!loadedHasMarker) {
            console.log(`  Loaded last 100 chars: "${loadedPersona.content.substring(loadedPersona.content.length - 100)}"`);
          }
        } else {
          console.log(`  Failed to load persona!`);
        }
      } else {
        console.log(`  Could not find content after frontmatter!`);
      }
    };

    test('1KB content', async () => {
      await testContentSize(1);
    });

    test('10KB content', async () => {
      await testContentSize(10);
    });

    test('50KB content', async () => {
      await testContentSize(50);
    });

    test('100KB content', async () => {
      await testContentSize(100);
    });

    test('500KB content', async () => {
      await testContentSize(500);
    });
  });

  describe('PersonaElement Serialization', () => {
    test('PersonaElement serialize preserves full content', () => {
      const largeContent = 'Test content '.repeat(10000); // ~130KB
      const endMarker = '\n\nEND_MARKER_SERIALIZATION';
      const fullContent = largeContent + endMarker;
      
      const persona = new PersonaElement({
        name: 'Test Element',
        description: 'Testing serialization',
        author: 'test'
      }, fullContent);
      
      console.log(`\n=== PersonaElement Serialization Test ===`);
      console.log(`  Original content size: ${fullContent.length} chars`);
      
      const serialized = persona.serialize();
      console.log(`  Serialized size: ${serialized.length} chars`);
      
      // Check if serialized content contains our marker
      const hasMarker = serialized.includes('END_MARKER_SERIALIZATION');
      console.log(`  Serialized contains marker: ${hasMarker}`);
      
      if (!hasMarker) {
        console.log(`  Last 200 chars of serialized: "${serialized.substring(serialized.length - 200)}"`);
      }
      
      expect(hasMarker).toBe(true);
    });
  });
});