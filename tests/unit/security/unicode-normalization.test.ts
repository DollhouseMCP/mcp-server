/**
 * Unicode Normalization Security Tests
 * Verifies that all user inputs are properly normalized to prevent Unicode-based attacks
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ServerSetup } from '../../../src/server/ServerSetup.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UnicodeValidator } from '../../../src/security/validators/unicodeValidator.js';
import { logger } from '../../../src/utils/logger.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';

import { ToolRegistry } from '../../../src/handlers/ToolRegistry.js';

describe('Unicode Normalization in Tool Calls', () => {
  let serverSetup: ServerSetup;
  let mockServer: any;
  let mockHandler: jest.Mock;
  let capturedHandler: any;
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    serverSetup = new ServerSetup(new ContextTracker());
    mockHandler = jest.fn(() => Promise.resolve({ content: [{ type: 'text', text: 'success' }] }));
    
    // Mock server to capture the request handler
    mockServer = {
      setRequestHandler: jest.fn((schema, handler) => {
        if (schema === CallToolRequestSchema) {
          capturedHandler = handler;
        }
      })
    };

    // Initialize the tool registry
    toolRegistry = new ToolRegistry(mockServer as any);

    // Setup server with our mock registry
    serverSetup.setupServer(mockServer as any, toolRegistry);
    
    // Manually register our test tool in the registry
    toolRegistry.register({
      name: 'testTool',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} }
    }, mockHandler as any);
  });

  it('should normalize Unicode in string arguments', async () => {
    // Test with confusable characters (Cyrillic 'а' that looks like Latin 'a')
    const request = {
      params: {
        name: 'testTool',
        arguments: {
          persona: 'аdmin' // Cyrillic 'а' + Latin 'dmin'
        }
      }
    };

    await capturedHandler(request);

    // Verify the handler was called with normalized Unicode
    expect(mockHandler).toHaveBeenCalledWith({
      persona: 'admin' // All normalized to Latin
    });
  });

  it('should normalize Unicode in nested objects', async () => {
    const request = {
      params: {
        name: 'testTool',
        arguments: {
          user: {
            name: 'tеst', // Mixed Latin and Cyrillic
            description: 'hello\u202Eworld' // Contains RLO character
          },
          tags: ['tаg1', 'tаg2'] // Cyrillic 'а' in tags
        }
      }
    };

    await capturedHandler(request);

    expect(mockHandler).toHaveBeenCalledWith({
      user: {
        name: 'test', // Normalized
        description: 'helloworld' // RLO removed
      },
      tags: ['tag1', 'tag2'] // Normalized
    });
  });

  it('should handle zero-width characters', async () => {
    const request = {
      params: {
        name: 'testTool',
        arguments: {
          content: 'hello\u200Bworld', // Zero-width space
          title: 'test\u200Ctitle' // Zero-width non-joiner
        }
      }
    };

    await capturedHandler(request);

    expect(mockHandler).toHaveBeenCalledWith({
      content: 'helloworld', // Zero-width removed
      title: 'testtitle' // Zero-width removed
    });
  });

  it('should handle direction override attacks', async () => {
    const request = {
      params: {
        name: 'testTool',
        arguments: {
          // RLO attack trying to reverse display
          filename: 'test\u202Etxt.exe' // Would display as "testexe.txt"
        }
      }
    };

    await capturedHandler(request);

    expect(mockHandler).toHaveBeenCalledWith({
      filename: 'testtxt.exe' // RLO removed, actual content preserved
    });
  });

  it('should preserve legitimate non-ASCII characters after normalization', async () => {
    const request = {
      params: {
        name: 'testTool',
        arguments: {
          // Legitimate use cases that should be normalized but preserved
          emoji: '😊🎭🏠', // Emojis should remain
          japanese: 'こんにちは', // Japanese should remain
          accented: 'café naïve résumé' // Accented chars should remain
        }
      }
    };

    await capturedHandler(request);

    expect(mockHandler).toHaveBeenCalledWith({
      emoji: '😊🎭🏠', // Preserved
      japanese: 'こんにちは', // Preserved
      accented: 'café naïve résumé' // Preserved (NFC normalized)
    });
  });

  it('should normalize arrays of strings', async () => {
    const request = {
      params: {
        name: 'testTool',
        arguments: {
          items: [
            'nоrmal', // Cyrillic 'о'
            'tеst\u200B', // Cyrillic 'е' + zero-width
            'hello\u202Dworld' // LRO character
          ]
        }
      }
    };

    await capturedHandler(request);

    expect(mockHandler).toHaveBeenCalledWith({
      items: [
        'normal', // Normalized
        'test', // Normalized and zero-width removed
        'helloworld' // LRO removed
      ]
    });
  });

  it('should handle null and undefined values', async () => {
    const request = {
      params: {
        name: 'testTool',
        arguments: {
          nullValue: null,
          undefinedValue: undefined,
          emptyString: '',
          validString: 'tеst' // Cyrillic 'е'
        }
      }
    };

    await capturedHandler(request);

    expect(mockHandler).toHaveBeenCalledWith({
      nullValue: null,
      undefinedValue: undefined,
      emptyString: '',
      validString: 'test' // Only this is normalized
    });
  });

  it('should preserve non-string types', async () => {
    const request = {
      params: {
        name: 'testTool',
        arguments: {
          number: 123,
          boolean: true,
          stringWithNumber: 'tеst123', // Cyrillic 'е'
          array: [1, 2, 3],
          object: { count: 42 }
        }
      }
    };

    await capturedHandler(request);

    expect(mockHandler).toHaveBeenCalledWith({
      number: 123,
      boolean: true,
      stringWithNumber: 'test123', // Normalized
      array: [1, 2, 3],
      object: { count: 42 }
    });
  });

  it('should normalize object keys containing Unicode', async () => {
    const request = {
      params: {
        name: 'testTool',
        arguments: {
          // Object with Unicode in keys
          'nаme': 'value1', // Cyrillic 'а' in key
          'test\u200B': 'value2', // Zero-width space in key
          normal: {
            'innеr': 'value3' // Cyrillic 'е' in nested key
          }
        }
      }
    };

    await capturedHandler(request);

    expect(mockHandler).toHaveBeenCalledWith({
      'name': 'value1', // Key normalized
      'test': 'value2', // Zero-width removed from key
      normal: {
        'inner': 'value3' // Nested key normalized
      }
    });
  });

  it('should handle tool names with Unicode gracefully', async () => {
    const request = {
      params: {
        name: 'tеstTool', // Cyrillic 'е' in tool name - won't match any registered tool
        arguments: { test: 'value' }
      }
    };

    // Should throw error for unknown tool (Unicode in tool names not normalized for security)
    await expect(capturedHandler(request)).rejects.toThrow('Unknown tool: tеstTool');
  });

  it('should detect and log Unicode security issues', async () => {
    const loggerSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const request = {
      params: {
        name: 'testTool',
        arguments: {
          // Multiple security issues
          malicious: 'admin\u202E\u200B' + // RLO + zero-width
                     'а' + // Cyrillic homograph
                     '\uFEFF' // Zero-width no-break space
        }
      }
    };

    await capturedHandler(request);

    // Verify security issues were logged
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unicode security issues detected'),
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.stringContaining('Direction override'),
          expect.stringContaining('Zero-width'),
          expect.stringContaining('Confusable')
        ])
      })
    );

    loggerSpy.mockRestore();
  });
});

// UpdateChecker tests removed - UpdateTools and UpdateChecker have been removed from the codebase

describe('ReDoS Protection', () => {
  it('should handle malformed surrogates without ReDoS', async () => {
    // Test with a string that would cause ReDoS with the old regex
    const maliciousInput = 'A' + '\uD800'.repeat(1000) + 'B'; // Many unpaired high surrogates
    
    const startTime = Date.now();
    const result = UnicodeValidator.normalize(maliciousInput);
    const endTime = Date.now();
    
    // Should complete quickly (under 100ms) even with malicious input
    expect(endTime - startTime).toBeLessThan(100);
    expect(result.detectedIssues).toContain('Malformed surrogate pairs detected');
  });

  it('should correctly identify various surrogate pair issues', () => {
    // High surrogate at end of string
    let result = UnicodeValidator.normalize('test\uD800');
    expect(result.detectedIssues).toContain('Malformed surrogate pairs detected');
    
    // Low surrogate without high surrogate
    result = UnicodeValidator.normalize('test\uDC00');
    expect(result.detectedIssues).toContain('Malformed surrogate pairs detected');
    
    // High surrogate followed by non-surrogate
    result = UnicodeValidator.normalize('test\uD800a');
    expect(result.detectedIssues).toContain('Malformed surrogate pairs detected');
    
    // Valid surrogate pair (should not detect issues)
    result = UnicodeValidator.normalize('test\uD800\uDC00'); // Valid pair
    expect(result.detectedIssues || []).not.toContain('Malformed surrogate pairs detected');
  });
});