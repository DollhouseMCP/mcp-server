/**
 * Test helpers for roundtrip workflow testing
 */

import fs from 'fs/promises';
import path from 'path';

export interface TestElement {
  name: string;
  type: 'persona' | 'skill' | 'template' | 'agent';
  version: string;
  author: string;
  content: string;
  metadata: Record<string, any>;
}

export interface TestScenario {
  name: string;
  description: string;
  steps: TestStep[];
  expectedResults: TestResult[];
}

export interface TestStep {
  action: string;
  parameters: Record<string, any>;
  expectedOutcome: 'success' | 'failure' | 'warning';
}

export interface TestResult {
  step: string;
  success: boolean;
  data?: any;
  error?: string;
  duration?: number;
}

/**
 * Create a test element with specified parameters
 */
export function createTestElement(config: Partial<TestElement>): TestElement {
  const defaults: TestElement = {
    name: 'test-element',
    type: 'skill',
    version: '1.0.0',
    author: 'test-suite',
    content: 'Test element content',
    metadata: {
      tags: ['test'],
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    }
  };

  return { ...defaults, ...config };
}

/**
 * Generate test element content in markdown format
 */
export function generateTestElementMarkdown(element: TestElement): string {
  const { name, type, version, author, content, metadata } = element;
  
  return `# ${name}

${content}

## Metadata
- Type: ${type}
- Version: ${version}
- Author: ${author}
- Tags: ${metadata.tags?.join(', ') || 'test'}
- Created: ${metadata.created}
- Updated: ${metadata.updated}

## Description

This is a test element generated for roundtrip workflow testing.

## Test Configuration

This element is configured for testing the following scenarios:
- Installation from collection
- Local modification
- Version tracking
- Portfolio submission
- Collection contribution

## Validation Points

- Metadata parsing: ✓
- Content preservation: ✓
- Version handling: ✓
- Type validation: ✓
- Author tracking: ✓
`;
}

/**
 * Create test elements with various edge cases
 */
export function createTestElementSet(): TestElement[] {
  return [
    // Standard valid element
    createTestElement({
      name: 'standard-test-skill',
      type: 'skill',
      version: '1.0.0',
      content: 'A standard test skill for basic validation.'
    }),

    // Element with unicode characters
    createTestElement({
      name: 'unicode-test-skill-ñáméd',
      type: 'skill',
      version: '1.0.0',
      content: 'A test skill with unicode characters: 🚀 中文 العربية',
      metadata: {
        tags: ['unicode', 'test', '中文'],
        created: new Date().toISOString(),
        updated: new Date().toISOString()
      }
    }),

    // Element with high version number
    createTestElement({
      name: 'high-version-test',
      type: 'persona',
      version: '99.99.999',
      content: 'A test persona with a very high version number.'
    }),

    // Element with long content
    createTestElement({
      name: 'large-content-test',
      type: 'template',
      version: '1.0.0',
      content: 'Lorem ipsum dolor sit amet, '.repeat(1000) + 'consectetur adipiscing elit.'
    }),

    // Element with special characters
    createTestElement({
      name: 'special-chars-test',
      type: 'skill',
      version: '1.0.0',
      content: 'Test with special characters: !@#$%^&*()[]{}|;:\'",.<>?`~',
      metadata: {
        tags: ['special-chars', 'edge-case'],
        created: new Date().toISOString(),
        updated: new Date().toISOString()
      }
    })
  ];
}

/**
 * Test scenario definitions
 */
export const TEST_SCENARIOS: TestScenario[] = [
  {
    name: 'Basic Roundtrip Workflow',
    description: 'Test the complete workflow with a standard element',
    steps: [
      {
        action: 'browse_collection',
        parameters: { section: 'library', type: 'skills' },
        expectedOutcome: 'success'
      },
      {
        action: 'install_content',
        parameters: { path: 'library/skills/roundtrip-test-skill.md' },
        expectedOutcome: 'success'
      },
      {
        action: 'edit_element',
        parameters: { name: 'roundtrip-test-skill', type: 'skills', version: '1.0.1' },
        expectedOutcome: 'success'
      },
      {
        action: 'submit_content',
        parameters: { content: 'roundtrip-test-skill' },
        expectedOutcome: 'success'
      }
    ],
    expectedResults: [
      { step: 'browse_collection', success: true },
      { step: 'install_content', success: true },
      { step: 'edit_element', success: true },
      { step: 'submit_content', success: true }
    ]
  },

  {
    name: 'Error Handling Test',
    description: 'Test error handling with invalid operations',
    steps: [
      {
        action: 'install_content',
        parameters: { path: 'library/invalid/non-existent.md' },
        expectedOutcome: 'failure'
      },
      {
        action: 'submit_content',
        parameters: { content: 'non-existent-element' },
        expectedOutcome: 'failure'
      },
      {
        action: 'edit_element',
        parameters: { name: 'missing-element', type: 'skills' },
        expectedOutcome: 'failure'
      }
    ],
    expectedResults: [
      { step: 'install_content', success: false },
      { step: 'submit_content', success: false },
      { step: 'edit_element', success: false }
    ]
  },

  {
    name: 'Unicode and Edge Cases',
    description: 'Test handling of unicode and special characters',
    steps: [
      {
        action: 'create_test_element',
        parameters: { 
          name: 'unicode-test-ñáméd',
          content: 'Content with unicode: 🚀 中文 العربية'
        },
        expectedOutcome: 'success'
      },
      {
        action: 'submit_content',
        parameters: { content: 'unicode-test-ñáméd' },
        expectedOutcome: 'success'
      }
    ],
    expectedResults: [
      { step: 'create_test_element', success: true },
      { step: 'submit_content', success: true }
    ]
  },

  {
    name: 'Configuration Management',
    description: 'Test portfolio and submission configuration',
    steps: [
      {
        action: 'portfolio_config',
        parameters: { auto_submit: false, auto_sync: true },
        expectedOutcome: 'success'
      },
      {
        action: 'submit_content',
        parameters: { content: 'test-element' },
        expectedOutcome: 'success'
      },
      {
        action: 'portfolio_config',
        parameters: { auto_submit: true },
        expectedOutcome: 'success'
      },
      {
        action: 'submit_content',
        parameters: { content: 'test-element' },
        expectedOutcome: 'success'
      }
    ],
    expectedResults: [
      { step: 'portfolio_config', success: true },
      { step: 'submit_content', success: true },
      { step: 'portfolio_config', success: true },
      { step: 'submit_content', success: true }
    ]
  }
];

/**
 * Validation utilities
 */
export class TestValidator {
  static validateElement(element: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (!element.name || typeof element.name !== 'string') {
      errors.push('Element name is required and must be a string');
    }
    
    if (!element.type || !['persona', 'skill', 'template', 'agent'].includes(element.type)) {
      errors.push('Element type must be one of: persona, skill, template, agent');
    }
    
    if (!element.version || !this.validateVersion(element.version)) {
      errors.push('Element version is required and must follow semantic versioning');
    }
    
    if (!element.author || typeof element.author !== 'string') {
      errors.push('Element author is required and must be a string');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  static validateVersion(version: string): boolean {
    // Basic semantic versioning validation
    const semVerRegex = /^\d+\.\d+\.\d+$/;
    return semVerRegex.test(version);
  }
  
  static validateMetadata(metadata: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (!metadata.created || !this.validateISO8601(metadata.created)) {
      errors.push('Created timestamp is required and must be valid ISO8601');
    }
    
    if (!metadata.updated || !this.validateISO8601(metadata.updated)) {
      errors.push('Updated timestamp is required and must be valid ISO8601');
    }
    
    if (metadata.tags && !Array.isArray(metadata.tags)) {
      errors.push('Tags must be an array if provided');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  static validateISO8601(dateString: string): boolean {
    try {
      const date = new Date(dateString);
      return date.toISOString() === dateString;
    } catch {
      return false;
    }
  }
}

/**
 * Test execution utilities
 */
export class TestExecutor {
  private results: TestResult[] = [];
  
  async executeScenario(scenario: TestScenario, server: any): Promise<TestResult[]> {
    console.log(`Executing scenario: ${scenario.name}`);
    this.results = [];
    
    for (const step of scenario.steps) {
      const startTime = Date.now();
      
      try {
        const result = await this.executeStep(step, server);
        const duration = Date.now() - startTime;
        
        this.results.push({
          step: step.action,
          success: result.success,
          data: result.data,
          error: result.error,
          duration
        });
        
        console.log(`Step ${step.action}: ${result.success ? 'SUCCESS' : 'FAILED'} (${duration}ms)`);
        
        if (result.error) {
          console.log(`Error: ${result.error}`);
        }
        
      } catch (error) {
        const duration = Date.now() - startTime;
        this.results.push({
          step: step.action,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration
        });
        
        console.log(`Step ${step.action}: ERROR (${duration}ms) - ${error}`);
      }
    }
    
    return this.results;
  }
  
  private async executeStep(step: TestStep, server: any): Promise<{ success: boolean; data?: any; error?: string }> {
    switch (step.action) {
      case 'browse_collection':
        return await server.handleTool('browse_collection', step.parameters);
      case 'search_collection':
        return await server.handleTool('search_collection', step.parameters);
      case 'install_content':
        return await server.handleTool('install_content', step.parameters);
      case 'edit_element':
        return await server.handleTool('edit_element', step.parameters);
      case 'submit_content':
        return await server.handleTool('submit_content', step.parameters);
      case 'portfolio_config':
        return await server.handleTool('portfolio_config', step.parameters);
      case 'portfolio_status':
        return await server.handleTool('portfolio_status', step.parameters);
      default:
        throw new Error(`Unknown test step action: ${step.action}`);
    }
  }
  
  getResults(): TestResult[] {
    return [...this.results];
  }
  
  getSummary(): { total: number; passed: number; failed: number; avgDuration: number } {
    const total = this.results.length;
    const passed = this.results.filter(r => r.success).length;
    const failed = total - passed;
    const avgDuration = this.results.reduce((sum, r) => sum + (r.duration || 0), 0) / total;
    
    return { total, passed, failed, avgDuration };
  }
}

/**
 * Cleanup utilities
 */
export class TestCleaner {
  static async cleanupTestElements(elementsDir: string): Promise<void> {
    try {
      const files = await fs.readdir(elementsDir);
      
      for (const file of files) {
        if (file.includes('test') || file.includes('roundtrip')) {
          const filePath = path.join(elementsDir, file);
          await fs.unlink(filePath);
          console.log(`Cleaned up test element: ${file}`);
        }
      }
    } catch (error) {
      console.warn('Error during test element cleanup:', error);
    }
  }
  
  static async cleanupTestRepositories(githubClient: any, testPrefix: string = 'test-'): Promise<void> {
    try {
      // This would require GitHub API integration
      console.log('Repository cleanup would be implemented with GitHub API calls');
    } catch (error) {
      console.warn('Error during repository cleanup:', error);
    }
  }
}