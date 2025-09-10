/**
 * TemplateRenderer Unicode Security Test
 * 
 * SECURITY: Verifies that Unicode normalization prevents homograph attacks
 * and other Unicode-based security issues.
 */

import { TemplateRenderer } from '../../../../src/utils/TemplateRenderer.js';
import { TemplateManager } from '../../../../src/elements/templates/TemplateManager.js';
import { Template } from '../../../../src/elements/templates/Template.js';
import { jest } from '@jest/globals';

describe('TemplateRenderer - Unicode Security', () => {
  let renderer: TemplateRenderer;
  let mockTemplateManager: jest.Mocked<TemplateManager>;
  
  beforeEach(() => {
    mockTemplateManager = {
      find: jest.fn(),
      list: jest.fn(),
      load: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      edit: jest.fn(),
      delete: jest.fn(),
      validate: jest.fn(),
      reload: jest.fn(),
      importElement: jest.fn(),
      exportElement: jest.fn()
    } as any;
    
    renderer = new TemplateRenderer(mockTemplateManager);
  });
  
  describe('Unicode Normalization Security', () => {
    it('should normalize template names to prevent homograph attacks', async () => {
      // Create a template with normal name
      const mockTemplate = new Template(
        { name: 'test', description: 'Test template' },
        'Content: {{value}}'
      );
      
      // Mock the render method to return interpolated content
      mockTemplate.render = jest.fn<() => Promise<string>>().mockResolvedValue('Content: data');
      
      // Only return template for normalized name
      mockTemplateManager.find.mockImplementation(async (predicate) => {
        // The predicate should be checking for normalized name
        const testTemplate = { metadata: { name: 'test' } };
        if (predicate(testTemplate as any)) {
          return mockTemplate;
        }
        return undefined;
      });
      
      // Try to access with Unicode homograph (е is Cyrillic, not Latin e)
      const homographName = 'tеst'; // Contains Cyrillic 'е' (U+0435)
      const result = await renderer.render(homographName, { value: 'data' });
      
      // Should normalize and find the template
      expect(result.success).toBe(true);
      expect(result.content).toBe('Content: data');
      expect(mockTemplate.render).toHaveBeenCalledWith({ value: 'data' });
    });
    
    it('should handle zero-width characters in template names', async () => {
      const mockTemplate = new Template(
        { name: 'template', description: 'Test' },
        'Content'
      );
      
      // Mock the render method
      mockTemplate.render = jest.fn<() => Promise<string>>().mockResolvedValue('Content');
      
      mockTemplateManager.find.mockImplementation(async (predicate) => {
        const testTemplate = { metadata: { name: 'template' } };
        if (predicate(testTemplate as any)) {
          return mockTemplate;
        }
        return undefined;
      });
      
      // Try with zero-width characters
      const nameWithZeroWidth = 'tem\u200Bpla\u200Cte'; // Contains zero-width spaces
      const result = await renderer.render(nameWithZeroWidth, {});
      
      // Should normalize and find the template
      expect(result.success).toBe(true);
      expect(result.content).toBe('Content');
    });
    
    it('should handle direction override attacks', async () => {
      const mockTemplate = new Template(
        { name: 'eruces', description: 'Test' },  // The normalized name after stripping RLO
        'Secure content'
      );
      
      // Mock the render method
      mockTemplate.render = jest.fn<() => Promise<string>>().mockResolvedValue('Secure content');
      
      mockTemplateManager.find.mockImplementation(async (predicate) => {
        // After normalization, '\u202Eeruces' becomes 'eruces'
        const testTemplate = { metadata: { name: 'eruces' } };
        if (predicate(testTemplate as any)) {
          return mockTemplate;
        }
        return undefined;
      });
      
      // Try with right-to-left override
      const rtlName = '\u202Eeruces'; // RLO character followed by reversed text
      const result = await renderer.render(rtlName, {});
      
      // Should normalize (strip RLO) and find the 'eruces' template
      expect(result.success).toBe(true);
      expect(result.content).toBe('Secure content');
    });
    
    it('should normalize names in batch operations', async () => {
      const template1 = new Template(
        { name: 'first', description: 'First' },
        'First: {{data}}'
      );
      
      // Mock render method for template1
      template1.render = jest.fn<() => Promise<string>>().mockResolvedValue('First: A');
      
      const template2 = new Template(
        { name: 'second', description: 'Second' },
        'Second: {{data}}'
      );
      
      // Mock render method for template2
      template2.render = jest.fn<() => Promise<string>>().mockResolvedValue('Second: B');
      
      let callCount = 0;
      mockTemplateManager.find.mockImplementation(async (predicate) => {
        callCount++;
        if (callCount === 1) {
          const test = { metadata: { name: 'first' } };
          if (predicate(test as any)) return template1;
        } else if (callCount === 2) {
          const test = { metadata: { name: 'second' } };
          if (predicate(test as any)) return template2;
        }
        return undefined;
      });
      
      // Use homograph characters in batch
      const results = await renderer.renderBatch([
        { name: 'fіrst', variables: { data: 'A' } }, // Cyrillic 'і'
        { name: 'sеcond', variables: { data: 'B' } } // Cyrillic 'е'
      ]);
      
      expect(results.size).toBe(2);
      const first = results.get('fіrst');
      expect(first?.success).toBe(true);
      expect(first?.content).toBe('First: A');
      
      const second = results.get('sеcond');
      expect(second?.success).toBe(true);
      expect(second?.content).toBe('Second: B');
    });
    
    it('should normalize names in validation', async () => {
      const mockTemplate = new Template(
        { name: 'validate', description: 'Test' },
        'Content'
      );
      
      mockTemplateManager.find.mockImplementation(async (predicate) => {
        const testTemplate = { metadata: { name: 'validate' } };
        if (predicate(testTemplate as any)) {
          return mockTemplate;
        }
        return undefined;
      });
      
      // Validate with Unicode variations
      const result1 = await renderer.validate('valіdate'); // Cyrillic 'і'
      expect(result1.valid).toBe(true);
      
      const result2 = await renderer.validate('val\u200Bidate'); // Zero-width space
      expect(result2.valid).toBe(true);
    });
    
    it('should handle combined Unicode attacks', async () => {
      const mockTemplate = new Template(
        { name: 'admin', description: 'Admin template' },
        'Admin access: {{level}}'
      );
      
      // Mock the render method
      mockTemplate.render = jest.fn<() => Promise<string>>().mockResolvedValue('Admin access: restricted');
      
      mockTemplateManager.find.mockImplementation(async (predicate) => {
        const testTemplate = { metadata: { name: 'admin' } };
        if (predicate(testTemplate as any)) {
          return mockTemplate;
        }
        return undefined;
      });
      
      // Combined attack: homograph + zero-width + direction override
      const maliciousName = '\u202Eadmіn\u200B'; // RLO + homograph + zero-width
      const result = await renderer.render(maliciousName, { level: 'restricted' });
      
      // Should safely normalize and render
      expect(result.success).toBe(true);
      expect(result.content).toBe('Admin access: restricted');
    });
  });
  
  describe('Error Messages with Unicode', () => {
    it('should use normalized name in error messages', async () => {
      mockTemplateManager.find.mockResolvedValue(undefined);
      
      const nameWithUnicode = 'tеmplatе'; // Cyrillic 'е' characters
      const result = await renderer.render(nameWithUnicode, {});
      
      // Error should reference the normalized name
      expect(result.success).toBe(false);
      expect(result.error).toContain('template'); // Normalized to ASCII
      expect(result.error).toContain('not found');
    });
  });
});

/**
 * SECURITY TEST SUMMARY:
 * 
 * These tests verify that Unicode normalization is properly applied to prevent:
 * 1. ✅ Homograph attacks (lookalike characters)
 * 2. ✅ Zero-width character injection
 * 3. ✅ Direction override attacks (RLO/LRO)
 * 4. ✅ Combined Unicode attack vectors
 * 5. ✅ Batch operation security
 * 6. ✅ Validation security
 * 
 * This addresses the MEDIUM severity security alert DMCP-SEC-004.
 */