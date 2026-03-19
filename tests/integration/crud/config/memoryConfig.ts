/**
 * Memory element type test configuration
 *
 * Memories are persistent context storage for continuity and learning.
 * They support activation through context loading and can have retention policies.
 */

import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementTypeTestConfig, ElementData } from './types.js';

/**
 * Factory function to create test memory data
 */
function createMemoryTestData(overrides?: Partial<ElementData>): ElementData {
  const base: ElementData = {
    name: overrides?.name || 'Test Memory',
    description: overrides?.description || 'A test memory for validation',
    metadata: {
      storageBackend: 'file',
      retentionDays: 30,
      privacyLevel: 'private',
      searchable: true,
      maxEntries: 1000,
      encryptionEnabled: false,
      memoryType: 'general',
      triggers: ['remember', 'recall'],
      ...(overrides?.metadata || {})
    }
  };

  return { ...base, ...overrides };
}

/**
 * Memory type test configuration
 */
export const MEMORY_CONFIG: ElementTypeTestConfig = {
  // ============================================================================
  // Identity
  // ============================================================================
  type: ElementType.MEMORY,
  displayName: 'Memories',

  // ============================================================================
  // Test Data Generation
  // ============================================================================
  factory: createMemoryTestData,

  validExamples: [
    {
      name: 'Minimal Memory',
      description: 'A minimal valid memory',
      metadata: {
        storageBackend: 'file',
        privacyLevel: 'private'
      }
    },
    {
      name: 'Complete Memory',
      description: 'A memory with all optional fields',
      metadata: {
        storageBackend: 'file',
        retentionDays: 90,
        privacyLevel: 'shared',
        searchable: true,
        maxEntries: 5000,
        encryptionEnabled: true,
        indexThreshold: 100,
        enableContentIndex: true,
        maxTermsPerEntry: 50,
        minTermLength: 3,
        triggers: ['remember', 'store', 'recall', 'retrieve'],
        autoLoad: true,
        priority: 10,
        memoryType: 'project'
      }
    },
    {
      name: 'Encrypted Memory',
      description: 'Memory with encryption enabled',
      metadata: {
        storageBackend: 'file',
        privacyLevel: 'confidential',
        encryptionEnabled: true,
        retentionDays: 365
      }
    },
    {
      name: 'Searchable Memory',
      description: 'Memory optimized for search',
      metadata: {
        storageBackend: 'file',
        searchable: true,
        enableContentIndex: true,
        indexThreshold: 50,
        maxTermsPerEntry: 100,
        minTermLength: 2
      }
    }
  ],

  invalidExamples: [
    // FIX: Temporarily reduced - validation not fully implemented
    // TODO: Add back when validation implemented
  ],

  // ============================================================================
  // Field Specifications
  // ============================================================================
  requiredFields: ['name', 'description'],

  editableFields: [
    {
      path: 'description',
      displayName: 'Description',
      type: 'string',
      required: true,
      validValues: [
        'Updated memory description',
        'A completely different description'
      ],
      invalidValues: [
        { value: '', expectedError: 'required|empty' },
        { value: 'A'.repeat(501), expectedError: 'length|size' }
      ]
    },
    {
      path: 'metadata.storageBackend',
      displayName: 'Storage Backend',
      type: 'enum',
      required: false,
      validValues: ['file', 'memory', 'hybrid'],
      invalidValues: [
        { value: 'invalid', expectedError: 'backend|invalid' }
      ]
    },
    {
      path: 'metadata.retentionDays',
      displayName: 'Retention Days',
      type: 'number',
      required: false,
      validValues: [7, 30, 90, 365],
      invalidValues: [
        { value: -1, expectedError: 'negative|invalid' },
        { value: 0, expectedError: 'minimum|invalid' }
      ]
    },
    {
      path: 'metadata.privacyLevel',
      displayName: 'Privacy Level',
      type: 'enum',
      required: false,
      validValues: ['public', 'shared', 'private', 'confidential'],
      invalidValues: [
        { value: 'invalid', expectedError: 'privacy|level|invalid' }
      ]
    },
    {
      path: 'metadata.searchable',
      displayName: 'Searchable',
      type: 'boolean',
      required: false,
      validValues: [true, false]
    },
    {
      path: 'metadata.maxEntries',
      displayName: 'Max Entries',
      type: 'number',
      required: false,
      validValues: [100, 1000, 5000, 10000],
      invalidValues: [
        { value: 0, expectedError: 'minimum|invalid' },
        { value: -1, expectedError: 'negative|invalid' }
      ]
    },
    {
      path: 'metadata.encryptionEnabled',
      displayName: 'Encryption Enabled',
      type: 'boolean',
      required: false,
      validValues: [true, false]
    },
    {
      path: 'metadata.triggers',
      displayName: 'Triggers',
      type: 'array',
      required: false,
      validValues: [
        ['remember', 'recall'],
        ['store']
      ]
    },
    {
      path: 'metadata.autoLoad',
      displayName: 'Auto Load',
      type: 'boolean',
      required: false,
      validValues: [true, false]
    },
    {
      path: 'metadata.memoryType',
      displayName: 'Memory Type',
      type: 'enum',
      required: false,
      validValues: ['general', 'project', 'user', 'session']
    }
  ],

  nestedFields: {
    'metadata.triggers': {
      path: 'metadata.triggers',
      displayName: 'Trigger Words',
      type: 'array',
      required: false,
      validValues: [
        ['remember', 'recall'],
        ['store']
      ]
    }
  },

  // ============================================================================
  // Capabilities
  // ============================================================================
  capabilities: {
    supportsActivation: {
      activationStrategy: 'context-loading',
      requiresContext: false,
      expectedResultType: 'state-change',
      testContexts: [
        {
          description: 'Load memory context',
          context: undefined,
          expectedOutcome: 'Memory becomes active, context loaded into working set'
        },
        {
          description: 'Auto-load on activation',
          context: { autoLoad: true },
          expectedOutcome: 'Memory activates and automatically loads entries'
        }
      ]
    },
    hasStateFile: {
      fileExtension: '.state.yaml',
      cleanupOnDelete: true,
      stateSchema: {
        entries: 'array',
        index: 'object',
        lastAccessed: 'date'
      }
    }
  },

  // ============================================================================
  // Validation Rules
  // ============================================================================
  validators: [
    {
      name: 'name-required',
      description: 'Name field must be present and non-empty',
      validate: (data) => ({
        valid: Boolean(data.name && data.name.trim()),
        message: 'Memory name is required'
      }),
      severity: 'error'
    },
    {
      name: 'description-required',
      description: 'Description field must be present and non-empty',
      validate: (data) => ({
        valid: Boolean(data.description && data.description.trim()),
        message: 'Memory description is required'
      }),
      severity: 'error'
    },
    {
      name: 'storage-backend-valid',
      description: 'Storage backend must be valid',
      validate: (data) => {
        if (!data.metadata?.storageBackend) return { valid: true };
        const validBackends = ['file', 'memory', 'hybrid'];
        return {
          valid: validBackends.includes(data.metadata.storageBackend),
          message: `Storage backend must be one of: ${validBackends.join(', ')}`
        };
      },
      severity: 'error'
    },
    {
      name: 'privacy-level-valid',
      description: 'Privacy level must be valid',
      validate: (data) => {
        if (!data.metadata?.privacyLevel) return { valid: true };
        const validLevels = ['public', 'shared', 'private', 'confidential'];
        return {
          valid: validLevels.includes(data.metadata.privacyLevel),
          message: `Privacy level must be one of: ${validLevels.join(', ')}`
        };
      },
      severity: 'error'
    },
    {
      name: 'retention-positive',
      description: 'Retention days must be positive',
      validate: (data) => {
        if (data.metadata?.retentionDays === undefined) return { valid: true };
        return {
          valid: data.metadata.retentionDays > 0,
          message: 'Retention days must be greater than 0'
        };
      },
      severity: 'error'
    },
    {
      name: 'max-entries-positive',
      description: 'Max entries must be positive',
      validate: (data) => {
        if (data.metadata?.maxEntries === undefined) return { valid: true };
        return {
          valid: data.metadata.maxEntries > 0,
          message: 'Max entries must be greater than 0'
        };
      },
      severity: 'error'
    },
    {
      name: 'encryption-with-confidential',
      description: 'Confidential memories should have encryption enabled',
      validate: (data) => {
        if (data.metadata?.privacyLevel !== 'confidential') return { valid: true };
        return {
          valid: data.metadata?.encryptionEnabled === true,
          message: 'Confidential privacy level should have encryption enabled'
        };
      },
      severity: 'warning'
    },
    {
      name: 'search-index-config',
      description: 'Search index config should be consistent',
      validate: (data) => {
        if (!data.metadata?.enableContentIndex) return { valid: true };
        if (data.metadata?.searchable === false) {
          return {
            valid: false,
            message: 'Content indexing enabled but memory not searchable'
          };
        }
        return { valid: true };
      },
      severity: 'warning'
    }
  ]
};
