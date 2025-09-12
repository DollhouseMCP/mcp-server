/**
 * Tests for BaseElement abstract class
 */

import { BaseElement, normalizeVersion } from '../../../../src/elements/BaseElement.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementStatus } from '../../../../src/types/elements/index.js';

// Create a concrete implementation for testing
class TestElement extends BaseElement {
  constructor(metadata: any = {}) {
    super(ElementType.PERSONA, metadata);
  }
}

describe('normalizeVersion', () => {
  it('should normalize short versions to full semver', () => {
    expect(normalizeVersion('1')).toBe('1.0.0');
    expect(normalizeVersion('2')).toBe('2.0.0');
    expect(normalizeVersion('1.0')).toBe('1.0.0');
    expect(normalizeVersion('1.1')).toBe('1.1.0');
    expect(normalizeVersion('2.5')).toBe('2.5.0');
  });
  
  it('should preserve full semver versions', () => {
    expect(normalizeVersion('1.0.0')).toBe('1.0.0');
    expect(normalizeVersion('2.1.3')).toBe('2.1.3');
    expect(normalizeVersion('10.20.30')).toBe('10.20.30');
  });
  
  it('should preserve prerelease and build metadata', () => {
    expect(normalizeVersion('1.0-beta')).toBe('1.0.0-beta');
    expect(normalizeVersion('1-alpha')).toBe('1.0.0-alpha');
    expect(normalizeVersion('1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(normalizeVersion('1.0.0+build123')).toBe('1.0.0+build123');
    expect(normalizeVersion('1.0.0-beta+build')).toBe('1.0.0-beta+build');
  });
  
  it('should return invalid versions unchanged', () => {
    expect(normalizeVersion('invalid')).toBe('invalid');
    expect(normalizeVersion('v1.0.0')).toBe('v1.0.0');
    expect(normalizeVersion('')).toBe('');
    expect(normalizeVersion('abc')).toBe('abc');
  });
});

describe('BaseElement', () => {
  describe('constructor', () => {
    it('should initialize with default values', () => {
      const element = new TestElement();
      
      expect(element.type).toBe(ElementType.PERSONA);
      expect(element.id).toBeDefined();
      expect(element.version).toBe('1.0.0');
      expect(element.metadata.name).toBe('Unnamed Element');
      expect(element.metadata.description).toBe('');
      expect(element.metadata.created).toBeDefined();
      expect(element.metadata.modified).toBeDefined();
      expect(element.metadata.tags).toEqual([]);
      expect(element.references).toEqual([]);
      expect(element.extensions).toEqual({});
      expect(element.ratings).toBeDefined();
      expect(element.ratings?.aiRating).toBe(0);
      expect(element.ratings?.trend).toBe('stable');
    });
    
    it('should use provided metadata', () => {
      const metadata = {
        name: 'Test Element',
        description: 'A test element',
        author: 'testuser',
        version: '2.0.0',
        tags: ['test', 'example']
      };
      
      const element = new TestElement(metadata);
      
      expect(element.metadata.name).toBe('Test Element');
      expect(element.metadata.description).toBe('A test element');
      expect(element.metadata.author).toBe('testuser');
      expect(element.version).toBe('2.0.0');
      expect(element.metadata.version).toBe('2.0.0');
      expect(element.metadata.tags).toEqual(['test', 'example']);
    });
    
    it('should generate ID based on name', () => {
      const element = new TestElement({ name: 'My Cool Element' });
      
      expect(element.id).toMatch(/^personas_my-cool-element_\d+$/);
    });
  });
  
  describe('validate', () => {
    it('should pass validation for valid element', () => {
      const element = new TestElement({
        name: 'Valid Element',
        description: 'A valid test element'
      });
      
      const result = element.validate();
      
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });
    
    it('should fail validation for missing name', () => {
      const element = new TestElement({ name: '   ' }); // Only whitespace
      
      const result = element.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.some(e => e.field === 'metadata.name')).toBe(true);
    });
    
    it('should warn about missing description', () => {
      const element = new TestElement({
        name: 'No Description',
        description: ''
      });
      
      const result = element.validate();
      
      expect(result.valid).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(w => w.field === 'metadata.description')).toBe(true);
    });
    
    it('should validate version format', () => {
      const element = new TestElement({ name: 'Test' });
      
      // Test invalid versions
      const invalidVersions = [
        'invalid-version',
        'v1.0.0',  // 'v' prefix not allowed
        '1.0.0.0', // Too many parts
        'abc',     // Non-numeric
        '',        // Empty
        '1.a',     // Letter in numeric part
        'beta'     // No numeric major version
      ];
      
      invalidVersions.forEach(version => {
        element.version = version;
        const result = element.validate();
        expect(result.valid).toBe(false);
        expect(result.errors?.some(e => e.field === 'version')).toBe(true);
      });
      
      // Test valid versions (new flexible formats)
      const validVersions = [
        '1',           // Major only
        '1.0',         // Major.minor
        '1.1',         // Common LLM format
        '2.0',         // Another common format
        '1.0.0',       // Full semver
        '2.1.3',       // Full semver
        '1.0.0-beta',  // With prerelease
        '1.0.0-alpha.1', // With prerelease and number
        '1.0-rc.1',    // Prerelease on major.minor
        '1.0.0+build123' // With build metadata
      ];
      
      validVersions.forEach(version => {
        element.version = version;
        const result = element.validate();
        if (!result.valid) {
          console.log(`Unexpected validation failure for version: ${version}`, result.errors);
        }
        expect(result.valid).toBe(true);
      });
    });
    
    it('should validate references', () => {
      const element = new TestElement({ name: 'Test' });
      element.references = [
        { type: 'external' as any, uri: '', title: 'Empty URI' }
      ];
      
      const result = element.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.field.includes('references'))).toBe(true);
    });
    
    it('should validate ratings range', () => {
      const element = new TestElement({ name: 'Test' });
      element.ratings!.aiRating = 6;
      
      const result = element.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.field === 'ratings.aiRating')).toBe(true);
    });
    
    it('should provide suggestions', () => {
      const element = new TestElement({ name: 'Basic Element' });
      
      const result = element.validate();
      
      expect(result.suggestions).toBeDefined();
      expect(result.suggestions?.some(s => s.includes('tags'))).toBe(true);
      expect(result.suggestions?.some(s => s.includes('author'))).toBe(true);
    });
  });
  
  describe('serialize/deserialize', () => {
    it('should serialize to markdown with YAML frontmatter', () => {
      const element = new TestElement({
        name: 'Test Element',
        description: 'For serialization'
      });
      
      const markdown = element.serialize();
      
      // Check it's markdown format with frontmatter
      expect(markdown).toContain('---');
      expect(markdown).toContain('name: Test Element');
      expect(markdown).toContain('description: For serialization');
      expect(markdown).toContain('type: personas');
      expect(markdown).toContain('# Test Element');
    });
    
    it('should deserialize from JSON', () => {
      const original = new TestElement({
        name: 'Original',
        description: 'Original description'
      });
      
      // Create JSON format for deserialization (still supports JSON input)
      const json = JSON.stringify({
        id: original.id,
        type: original.type,
        version: original.version,
        metadata: original.metadata,
        references: original.references,
        extensions: original.extensions,
        ratings: original.ratings
      });
      
      const element = new TestElement();
      element.deserialize(json);
      
      expect(element.id).toBe(original.id);
      expect(element.metadata.name).toBe('Original');
      expect(element.metadata.description).toBe('Original description');
    });
    
    it('should throw on invalid JSON', () => {
      const element = new TestElement();
      
      expect(() => element.deserialize('invalid json')).toThrow();
    });
    
    it('should throw on missing required fields', () => {
      const element = new TestElement();
      const invalidData = JSON.stringify({ type: 'test' });
      
      expect(() => element.deserialize(invalidData)).toThrow('missing required fields');
    });
  });
  
  describe('receiveFeedback', () => {
    it('should process positive feedback', () => {
      const element = new TestElement({ name: 'Test' });
      
      element.receiveFeedback('This is excellent! Really helpful.');
      
      expect(element.ratings?.feedbackHistory).toHaveLength(1);
      expect(element.ratings?.feedbackHistory?.[0].sentiment).toBe('positive');
      expect(element.ratings?.feedbackHistory?.[0].inferredRating).toBeGreaterThanOrEqual(4);
    });
    
    it('should process negative feedback', () => {
      const element = new TestElement({ name: 'Test' });
      
      element.receiveFeedback('This is terrible and completely useless.');
      
      expect(element.ratings?.feedbackHistory).toHaveLength(1);
      expect(element.ratings?.feedbackHistory?.[0].sentiment).toBe('negative');
      expect(element.ratings?.feedbackHistory?.[0].inferredRating).toBeLessThanOrEqual(2);
    });
    
    it('should process neutral feedback', () => {
      const element = new TestElement({ name: 'Test' });
      
      element.receiveFeedback('It\'s okay, nothing special.');
      
      expect(element.ratings?.feedbackHistory).toHaveLength(1);
      expect(element.ratings?.feedbackHistory?.[0].sentiment).toBe('neutral');
      expect(element.ratings?.feedbackHistory?.[0].inferredRating).toBe(3);
    });
    
    it('should extract explicit ratings', () => {
      const element = new TestElement({ name: 'Test' });
      
      element.receiveFeedback('I would rate this 4 out of 5 stars.');
      
      expect(element.ratings?.feedbackHistory?.[0].inferredRating).toBe(4);
      expect(element.ratings?.userRating).toBe(4);
    });
    
    it('should update user rating average', () => {
      const element = new TestElement({ name: 'Test' });
      
      element.receiveFeedback('5 stars!');
      element.receiveFeedback('3 stars');
      element.receiveFeedback('4 stars');
      
      expect(element.ratings?.userRating).toBe(4); // (5+3+4)/3
      expect(element.ratings?.ratingCount).toBe(3);
    });
    
    it('should track rating trend', () => {
      const element = new TestElement({ name: 'Test' });
      
      // Add mostly positive feedback
      element.receiveFeedback('Great!');
      element.receiveFeedback('Excellent work');
      element.receiveFeedback('Very good');
      element.receiveFeedback('Nice');
      element.receiveFeedback('Okay');
      
      expect(element.ratings?.trend).toBe('improving');
    });
    
    it('should mark element as dirty after feedback', () => {
      const element = new TestElement({ name: 'Test' });
      
      expect(element.isDirty()).toBe(false);
      element.receiveFeedback('Some feedback');
      expect(element.isDirty()).toBe(true);
    });
  });
  
  describe('lifecycle methods', () => {
    it('should handle activation lifecycle', async () => {
      const element = new TestElement({ name: 'Test' });
      
      expect(element.getStatus()).toBe(ElementStatus.INACTIVE);
      
      await element.beforeActivate();
      expect(element.getStatus()).toBe(ElementStatus.ACTIVATING);
      
      await element.activate();
      expect(element.getStatus()).toBe(ElementStatus.ACTIVE);
      
      await element.afterActivate();
      expect(element.getStatus()).toBe(ElementStatus.ACTIVE);
    });
    
    it('should handle deactivation', async () => {
      const element = new TestElement({ name: 'Test' });
      await element.activate();
      
      expect(element.getStatus()).toBe(ElementStatus.ACTIVE);
      
      await element.deactivate();
      expect(element.getStatus()).toBe(ElementStatus.INACTIVE);
    });
  });
  
  describe('dirty state management', () => {
    it('should track dirty state', () => {
      const element = new TestElement({ name: 'Test' });
      
      expect(element.isDirty()).toBe(false);
      
      // Access protected method through type assertion
      (element as any).markDirty();
      expect(element.isDirty()).toBe(true);
      
      element.markClean();
      expect(element.isDirty()).toBe(false);
    });
    
    it('should update modified timestamp when marked dirty', async () => {
      const element = new TestElement({ name: 'Test' });
      const originalModified = element.metadata.modified;
      
      // Sleep briefly to ensure timestamp difference
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      await sleep(10);
      
      (element as any).markDirty();
      expect(element.metadata.modified).not.toBe(originalModified);
    });
  });
});