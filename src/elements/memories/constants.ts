/**
 * Constants for Memory element implementation
 * Extracted for reusability and maintainability
 */

// Memory size limits
export const MEMORY_CONSTANTS = {
  // Size limits
  MAX_MEMORY_SIZE: 1024 * 1024,        // 1MB total memory size
  MAX_ENTRY_SIZE: 100 * 1024,          // 100KB per entry
  MAX_ENTRIES_DEFAULT: 1000,           // Maximum number of entries
  
  // Entry limits
  MAX_TAGS_PER_ENTRY: 20,              // Maximum tags per memory entry
  MAX_TAG_LENGTH: 50,                  // Maximum length of each tag
  MAX_METADATA_KEYS: 20,               // Maximum metadata keys per entry
  MAX_METADATA_KEY_LENGTH: 50,         // Maximum metadata key length
  MAX_METADATA_VALUE_LENGTH: 200,      // Maximum metadata value length
  
  // Retention defaults
  DEFAULT_RETENTION_DAYS: 30,          // Default retention period
  MIN_RETENTION_DAYS: 1,               // Minimum retention period
  MAX_RETENTION_DAYS: 365,             // Maximum retention period
  
  // Search limits
  DEFAULT_SEARCH_LIMIT: 100,           // Default search result limit
  
  // YAML limits
  MAX_YAML_SIZE: 256 * 1024,           // 256KB max YAML size for import
  
  // Privacy levels (ordered by access level)
  PRIVACY_LEVELS: ['public', 'private', 'sensitive'] as const,
  DEFAULT_PRIVACY_LEVEL: 'private' as const,
  
  // Storage backends
  DEFAULT_STORAGE_BACKEND: 'memory' as const,
  SUPPORTED_STORAGE_BACKENDS: ['memory', 'file', 'indexed'] as const,
} as const;

// Type exports for privacy levels and storage backends
export type PrivacyLevel = typeof MEMORY_CONSTANTS.PRIVACY_LEVELS[number];
export type StorageBackend = typeof MEMORY_CONSTANTS.SUPPORTED_STORAGE_BACKENDS[number];

// Security event types for memory operations
export const MEMORY_SECURITY_EVENTS = {
  MEMORY_CREATED: 'MEMORY_CREATED',
  MEMORY_ADDED: 'MEMORY_ADDED',
  MEMORY_SEARCHED: 'MEMORY_SEARCHED',
  SENSITIVE_MEMORY_DELETED: 'SENSITIVE_MEMORY_DELETED',
  RETENTION_POLICY_ENFORCED: 'RETENTION_POLICY_ENFORCED',
  MEMORY_CLEARED: 'MEMORY_CLEARED',
  MEMORY_LOADED: 'MEMORY_LOADED',
  MEMORY_SAVED: 'MEMORY_SAVED',
  MEMORY_DELETED: 'MEMORY_DELETED',
  MEMORY_LOAD_FAILED: 'MEMORY_LOAD_FAILED',
  MEMORY_SAVE_FAILED: 'MEMORY_SAVE_FAILED',
  MEMORY_DESERIALIZE_FAILED: 'MEMORY_DESERIALIZE_FAILED',
  MEMORY_LIST_ITEM_FAILED: 'MEMORY_LIST_ITEM_FAILED',
  MEMORY_IMPORT_FAILED: 'MEMORY_IMPORT_FAILED',
} as const;