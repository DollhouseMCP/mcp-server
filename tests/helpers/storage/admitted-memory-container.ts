/** Normal server registrar composed only inside owned test fixtures. */
import { DollhouseContainer } from '../../../src/di/Container.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { InMemoryOperatorConfigStore } from '../../../src/storage/operatorConfig/InMemoryOperatorConfigStore.js';
import { InMemoryUserConfigStore } from '../../../src/storage/userConfig/InMemoryUserConfigStore.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import type { AdmittedDatabaseMemoryManagerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { UserIdResolver } from '../../../src/database/UserContext.js';
import type { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';

export function admittedMemoryContainer(db: DatabaseInstance, getUser: UserIdResolver, baseDir: string,
  configureProvider?: (factory: DatabaseStorageLayerFactory) => AdmittedDatabaseMemoryManagerFactory,
  admitted = true) {
  const container = new DollhouseContainer();
  container.register('OperatorConfigStore', () => new InMemoryOperatorConfigStore());
  container.register('UserConfigStore', () => new InMemoryUserConfigStore());
  container.replace('FileLockManager', () => new FileLockManager());
  container.replace('FileOperationsService', () => new FileOperationsService(container.resolve('FileLockManager')));
  container.replace('PortfolioManager', () => new PortfolioManager(container.resolve('FileOperationsService'), { baseDir }));
  const factory = new DatabaseStorageLayerFactory(db, getUser);
  container.replace('StorageLayerFactory', () => factory);
  container.register('UserIdResolver', () => getUser, { override: container.hasRegistration('UserIdResolver') });
  if (admitted) container.register('AdmittedDatabaseMemoryManagerFactory', () =>
    configureProvider?.(factory) ?? factory.createAdmittedMemoryManager.bind(factory));
  return { container, factory, manager: () => container.resolve<MemoryManager>('MemoryManager') };
}
