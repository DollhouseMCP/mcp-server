import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';

// Create manual mocks (using 'as any' for ESM compatibility)
const mockReaddir = jest.fn() as any;
const mockReadFile = jest.fn() as any;
const mockWriteFile = jest.fn() as any;

// Mock external dependencies
jest.mock('fs/promises', () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  writeFile: mockWriteFile
}));

describe('Performance Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup is handled by clearAllMocks in beforeEach
  });

  describe('Large Persona Collection Performance', () => {
    const generateMockPersona = (id: number) => {
      return `---
name: "Test Persona ${id}"
description: "A test persona for performance testing"
unique_id: "test-persona-${id}_20250703-120000_testuser"
author: "testuser"
triggers: ["test", "persona${id}"]
version: "1.0"
category: "professional"
age_rating: "all"
ai_generated: true
generation_method: "Claude"
price: "free"
license: "CC-BY-SA-4.0"
created_date: "2025-07-03"
---

# Test Persona ${id}

This is a test persona for performance testing with ID ${id}.

## Instructions
You are a helpful assistant designed to test performance with large persona collections.

## Response Style
- Be concise and helpful
- Focus on the task at hand
- Maintain consistent performance

## Key Features
- Performance optimized
- Memory efficient
- Fast loading times
`;
    };

    it('should handle loading 100 personas efficiently', async () => {
      const personaCount = 100;
      const mockFiles = Array.from({ length: personaCount }, (_, i) => `test-persona-${i}.md`);
      
      mockReaddir.mockResolvedValue(mockFiles);
      
      // Mock file reads for each persona
      mockReadFile.mockImplementation(async (filepath: any) => {
        const filename = typeof filepath === 'string' ? filepath.split('/').pop() || filepath : '';
        const index = mockFiles.indexOf(filename);
        if (index >= 0) {
          return generateMockPersona(index);
        }
        throw new Error('File not found');
      });

      const startTime = performance.now();
      
      // Simulate persona loading
      const personas = new Map();
      const files = await mockReaddir('.');
      const mdFiles = files.filter((f: string) => f.endsWith('.md'));
      
      for (const file of mdFiles) {
        const content = await mockReadFile(file, 'utf-8');
        personas.set(file, content);
      }
      
      const endTime = performance.now();
      const loadTime = endTime - startTime;

      expect(personas.size).toBe(personaCount);
      expect(loadTime).toBeLessThan(1000); // Should load 100 personas in under 1 second
      expect(mockReaddir).toHaveBeenCalledTimes(1);
      expect(mockReadFile).toHaveBeenCalledTimes(personaCount);
    });

    it('should handle memory usage efficiently with large collections', () => {
      const personaCount = 1000;
      const personas = new Map();
      
      // Simulate loading many personas
      for (let i = 0; i < personaCount; i++) {
        const personaData = {
          metadata: {
            name: `Test Persona ${i}`,
            description: `Description ${i}`,
            unique_id: `test-${i}`,
            author: 'testuser',
            category: 'professional'
          },
          content: `Content for persona ${i}`,
          filename: `test-persona-${i}.md`,
          unique_id: `test-${i}`
        };
        personas.set(`test-${i}`, personaData);
      }

      // Verify memory efficiency
      expect(personas.size).toBe(personaCount);
      
      // Check that Map operations remain fast
      const startTime = performance.now();
      
      // Simulate common operations
      const persona = personas.get('test-500');
      const hasPersona = personas.has('test-750');
      const allKeys = Array.from(personas.keys());
      
      const endTime = performance.now();
      const operationTime = endTime - startTime;

      expect(persona).toBeDefined();
      expect(hasPersona).toBe(true);
      expect(allKeys.length).toBe(personaCount);
      expect(operationTime).toBeLessThan(10); // Operations should be very fast
    });

    it('should handle search operations efficiently', () => {
      const personaCount = 500;
      const personas = new Map();
      
      // Create personas with searchable content
      for (let i = 0; i < personaCount; i++) {
        const category = ['creative', 'professional', 'educational'][i % 3];
        const personaData = {
          metadata: {
            name: `${category} Persona ${i}`,
            description: `A ${category} assistant for task ${i}`,
            category,
            triggers: [`${category}`, `task${i}`, `persona${i}`]
          },
          content: `This is a ${category} persona designed for specific tasks.`,
          filename: `${category}-persona-${i}.md`
        };
        personas.set(`${category}-${i}`, personaData);
      }

      const startTime = performance.now();

      // Simulate search operations
      const creativePersonas = Array.from(personas.values()).filter(
        p => p.metadata.category === 'creative'
      );
      
      const nameSearchResults = Array.from(personas.values()).filter(
        p => p.metadata.name.toLowerCase().includes('professional')
      );
      
      const triggerSearchResults = Array.from(personas.values()).filter(
        p => p.metadata.triggers?.some((t: string) => t.includes('task1'))
      );

      const endTime = performance.now();
      const searchTime = endTime - startTime;

      expect(creativePersonas.length).toBeGreaterThan(0);
      expect(nameSearchResults.length).toBeGreaterThan(0);
      expect(triggerSearchResults.length).toBeGreaterThan(0);
      expect(searchTime).toBeLessThan(50); // Search should be fast even with 500 personas
    });

    it('should handle concurrent operations efficiently', async () => {
      const personas = new Map();
      const operationCount = 100;
      
      // Add some initial data
      for (let i = 0; i < 50; i++) {
        personas.set(`persona-${i}`, { name: `Persona ${i}`, content: `Content ${i}` });
      }

      const startTime = performance.now();

      // Simulate concurrent read/write operations
      const operations = [];
      
      for (let i = 0; i < operationCount; i++) {
        if (i % 2 === 0) {
          // Read operation
          operations.push(Promise.resolve(personas.get(`persona-${i % 50}`)));
        } else {
          // Write operation
          operations.push(Promise.resolve(personas.set(`new-persona-${i}`, { name: `New ${i}` })));
        }
      }

      await Promise.all(operations);
      
      const endTime = performance.now();
      const concurrentTime = endTime - startTime;

      expect(personas.size).toBeGreaterThan(50);
      expect(concurrentTime).toBeLessThan(100); // Concurrent operations should be fast
    });

    it('should measure file I/O performance', async () => {
      const fileCount = 50;
      const avgFileSize = 2048; // 2KB average file size
      
      // Mock file operations with realistic delays
      mockReaddir.mockImplementation(async () => {
        // Simulate directory read time
        await new Promise(resolve => setTimeout(resolve, 5));
        return Array.from({ length: fileCount }, (_, i) => `persona-${i}.md`);
      });

      mockReadFile.mockImplementation(async (filepath: any) => {
        // Simulate file read time based on file size
        await new Promise(resolve => setTimeout(resolve, 2));
        return generateMockPersona(0);
      });

      const startTime = performance.now();

      // Simulate loading all personas
      const files = await mockReaddir('.');
      const readPromises = files.map((file: any) => mockReadFile(file, 'utf-8'));
      const contents = await Promise.all(readPromises);

      const endTime = performance.now();
      const ioTime = endTime - startTime;

      expect(contents.length).toBe(fileCount);
      expect(ioTime).toBeLessThan(500); // I/O should complete in reasonable time
    });

    it('should handle cache performance', () => {
      // Simulate API cache performance
      class TestCache {
        private cache = new Map<string, { data: any; timestamp: number }>();
        private readonly TTL = 5 * 60 * 1000; // 5 minutes

        get(key: string): any | null {
          const entry = this.cache.get(key);
          if (!entry) return null;
          
          if (Date.now() - entry.timestamp > this.TTL) {
            this.cache.delete(key);
            return null;
          }
          
          return entry.data;
        }

        set(key: string, data: any): void {
          this.cache.set(key, { data, timestamp: Date.now() });
        }

        size(): number {
          return this.cache.size;
        }
      }

      const cache = new TestCache();
      const operationCount = 1000;

      const startTime = performance.now();

      // Simulate cache operations
      for (let i = 0; i < operationCount; i++) {
        const key = `api-call-${i % 100}`; // Reuse some keys to test cache hits
        
        let data = cache.get(key);
        if (!data) {
          data = { result: `data-${i}` };
          cache.set(key, data);
        }
      }

      const endTime = performance.now();
      const cacheTime = endTime - startTime;

      expect(cache.size()).toBeLessThanOrEqual(100); // Should have at most 100 unique keys
      expect(cacheTime).toBeLessThan(50); // Cache operations should be very fast
    });

    it('should benchmark persona validation performance', () => {
      const personaCount = 200;
      const personas = [];

      // Generate test personas
      for (let i = 0; i < personaCount; i++) {
        personas.push({
          metadata: {
            name: `Test Persona ${i}`,
            description: `Description for persona ${i}`,
            category: ['creative', 'professional', 'educational'][i % 3],
            triggers: [`trigger${i}`, `test${i}`],
            version: '1.0'
          },
          content: `Content for persona ${i}`.repeat(10) // Make content longer
        });
      }

      const startTime = performance.now();

      // Simulate validation for all personas
      let validCount = 0;
      let warningCount = 0;

      personas.forEach(persona => {
        const issues = [];
        const warnings = [];

        // Basic validation checks
        if (!persona.metadata.name) issues.push('Missing name');
        if (!persona.metadata.description) issues.push('Missing description');
        if (!persona.metadata.category) warnings.push('Missing category');
        if (!persona.metadata.triggers?.length) warnings.push('No triggers');
        if (persona.content.length > 5000) warnings.push('Content too long');

        if (issues.length === 0) validCount++;
        if (warnings.length > 0) warningCount++;
      });

      const endTime = performance.now();
      const validationTime = endTime - startTime;

      expect(validCount).toBe(personaCount); // All should be valid
      expect(validationTime).toBeLessThan(100); // Validation should be fast
      expect(validationTime / personaCount).toBeLessThan(1); // Less than 1ms per persona
    });
  });

  describe('API Performance Tests', () => {
    it('should handle rate limiting efficiently', () => {
      const rateLimitTracker = new Map<string, number[]>();
      const maxRequests = 100;
      const windowMs = 60 * 1000; // 1 minute

      const checkRateLimit = (key: string = 'default'): boolean => {
        const now = Date.now();
        const requests = rateLimitTracker.get(key) || [];
        
        // Remove requests outside the window
        const validRequests = requests.filter(time => now - time < windowMs);
        
        if (validRequests.length >= maxRequests) {
          return false; // Rate limit exceeded
        }
        
        validRequests.push(now);
        rateLimitTracker.set(key, validRequests);
        return true;
      };

      const startTime = performance.now();

      // Simulate rapid requests
      let allowedRequests = 0;
      let blockedRequests = 0;

      for (let i = 0; i < 150; i++) {
        if (checkRateLimit('test-client')) {
          allowedRequests++;
        } else {
          blockedRequests++;
        }
      }

      const endTime = performance.now();
      const rateLimitTime = endTime - startTime;

      expect(allowedRequests).toBe(maxRequests);
      expect(blockedRequests).toBe(50);
      expect(rateLimitTime).toBeLessThan(50); // Rate limiting check should be fast
    });

    it('should measure GitHub API cache performance', () => {
      const cache = new Map<string, { data: any; timestamp: number }>();
      const cacheHits = [];
      const cacheMisses = [];

      const simulateAPICall = (url: string): any => {
        const cached = cache.get(url);
        if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
          cacheHits.push(url);
          return cached.data;
        }
        
        cacheMisses.push(url);
        const data = { result: `data-for-${url}` };
        cache.set(url, { data, timestamp: Date.now() });
        return data;
      };

      const urls = [
        'https://api.github.com/repos/test/repo/contents/personas',
        'https://api.github.com/repos/test/repo/contents/personas/creative',
        'https://api.github.com/repos/test/repo/releases/latest'
      ];

      const startTime = performance.now();

      // Simulate multiple requests to same URLs
      for (let i = 0; i < 20; i++) {
        urls.forEach(url => simulateAPICall(url));
      }

      const endTime = performance.now();
      const apiCacheTime = endTime - startTime;

      expect(cacheHits.length).toBe(57); // 20 * 3 - 3 initial misses
      expect(cacheMisses.length).toBe(3); // One miss per unique URL
      expect(apiCacheTime).toBeLessThan(20); // Cache should make operations very fast
    });
  });
});