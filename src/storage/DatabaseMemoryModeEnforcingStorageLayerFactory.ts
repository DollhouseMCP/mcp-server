/** Dormant composition only. The production registrar does not select this factory. */
import type { DatabaseInstance } from '../database/connection.js';
import type { UserIdResolver } from '../database/UserContext.js';
import type { FileStorageOptions } from './IStorageLayerFactory.js';
import type { IStorageLayer } from './IStorageLayer.js';
import { DatabaseStorageLayerFactory } from './DatabaseStorageLayerFactory.js';
import { DatabaseMemoryStorageLayer } from './DatabaseMemoryStorageLayer.js';
import { DatabaseMemoryLegacyMutationGuard } from './DatabaseMemoryLegacyMutationGuard.js';

export class DatabaseMemoryModeEnforcingStorageLayerFactory extends DatabaseStorageLayerFactory {
  constructor(private readonly boundDb: DatabaseInstance, private readonly boundTenant: UserIdResolver) {
    super(boundDb, boundTenant);
  }

  override createForElement(elementType: string, options: FileStorageOptions): IStorageLayer {
    if (elementType !== 'memories') return super.createForElement(elementType, options);
    return new DatabaseMemoryStorageLayer(this.boundDb, this.boundTenant,
      new DatabaseMemoryLegacyMutationGuard(this.boundDb, this.boundTenant));
  }
}
