/**
 * Storage layer barrel exports.
 */

// Types
export type {
  StorageItemMetadata,
  ElementIndexEntry,
  ManifestDiffResult,
} from './types.js';

// Interfaces
export type { IStorageBackend } from './IStorageBackend.js';
export type { IStorageLayer } from './IStorageLayer.js';

// Classes — Phase 1 (ElementStorageLayer for .md elements)
export { FrontmatterParser } from './FrontmatterParser.js';
export type { FrontmatterData } from './FrontmatterParser.js';
export { FileStorageBackend } from './FileStorageBackend.js';
export { StorageManifest } from './StorageManifest.js';
export { MetadataIndex } from './MetadataIndex.js';
export { ElementStorageLayer } from './ElementStorageLayer.js';
export type { ElementStorageLayerOptions } from './ElementStorageLayer.js';

// Classes — Phase 2 (MemoryStorageLayer for .yaml memories)
export { MemoryMetadataExtractor } from './MemoryMetadataExtractor.js';
export { MemoryIndexFile } from './MemoryIndexFile.js';
export type { MemoryIndexData, MemoryIndexFileOptions } from './MemoryIndexFile.js';
export { MemoryStorageLayer } from './MemoryStorageLayer.js';
export type { MemoryStorageLayerOptions } from './MemoryStorageLayer.js';
