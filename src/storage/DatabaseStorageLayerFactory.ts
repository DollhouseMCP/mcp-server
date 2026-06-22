/**
 * DatabaseStorageLayerFactory — database-backed storage layer creation.
 *
 * Creates DatabaseStorageLayer for most element types and
 * DatabaseMemoryStorageLayer for memories (which syncs YAML entries
 * into the memory_entries table). The DB connection and per-call
 * userId resolver are held as instance state, injected at factory
 * construction time by DatabaseServiceRegistrar.
 *
 * This file is DYNAMICALLY IMPORTED by DatabaseServiceRegistrar.
 * It is never statically in the import graph. drizzle-orm stays
 * out of file-mode deployments and tests entirely.
 *
 * @since Step 4.5 Commit 2.5
 */

import type { DatabaseInstance } from '../database/connection.js';
import type { UserIdResolver } from '../database/UserContext.js';
import type { IStorageLayer } from './IStorageLayer.js';
import type { IStorageLayerFactory, FileStorageOptions } from './IStorageLayerFactory.js';
import { DatabaseStorageLayer } from './DatabaseStorageLayer.js';
import { DatabaseMemoryStorageLayer } from './DatabaseMemoryStorageLayer.js';

export class DatabaseStorageLayerFactory implements IStorageLayerFactory {
  constructor(
    private readonly db: DatabaseInstance,
    private readonly getCurrentUserId: UserIdResolver,
  ) {}

  createForElement(elementType: string, _fileOptions: FileStorageOptions): IStorageLayer {
    if (elementType === 'memories') {
      return new DatabaseMemoryStorageLayer(this.db, this.getCurrentUserId);
    }
    return new DatabaseStorageLayer(this.db, this.getCurrentUserId, elementType);
  }
}
