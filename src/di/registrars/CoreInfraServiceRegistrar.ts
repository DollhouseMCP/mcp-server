/**
 * CoreInfraServiceRegistrar
 *
 * Owns the DI wiring for core infrastructure services: caching, storage,
 * configuration, file operations, validation, and element-agnostic query
 * services. These services are universal — every deployment mode uses them.
 *
 * Responsibilities:
 * - StartupTimer, CacheMemoryBudget, APICache, RateLimitTracker
 * - FileLockManager, FileOperationsService, StorageLayerFactory
 * - ConfigManager, RetentionPolicyService, IndexConfigManager
 * - IndicatorConfig, StateChangeNotifier, MCPLogger
 * - SerializationService, MetadataService, TriggerValidationService
 * - ValidationService, FileWatchService, ValidationRegistry
 * - PaginationService, FilterService, SortService, ElementQueryService
 *
 * @module di/registrars/CoreInfraServiceRegistrar
 */

import os from 'os';

import { loadIndicatorConfig } from '../../config/indicator-config.js';
import {
  getValidatedGlobalCacheMemoryBytes,
  getValidatedIndexDebounce,
} from '../../config/performance-constants.js';
import { APICache, CacheMemoryBudget } from '../../cache/index.js';
import { ConfigManager } from '../../config/ConfigManager.js';
import { IndexConfigManager } from '../../portfolio/config/IndexConfig.js';
import { FileLockManager } from '../../security/fileLockManager.js';
import { FileOperationsService } from '../../services/FileOperationsService.js';
import { FileStorageLayerFactory, defaultMemoryFileFilter } from '../../storage/FileStorageLayerFactory.js';
import type { IStorageLayerFactory } from '../../storage/IStorageLayerFactory.js';
import { RetentionPolicyService, MemoryRetentionStrategy } from '../../services/RetentionPolicyService.js';
import { StateChangeNotifier } from '../../services/StateChangeNotifier.js';
import { SerializationService } from '../../services/SerializationService.js';
import { MetadataService } from '../../services/MetadataService.js';
import { TriggerValidationService } from '../../services/validation/TriggerValidationService.js';
import { ValidationService } from '../../services/validation/ValidationService.js';
import { FileWatchService } from '../../services/FileWatchService.js';
import { ValidationRegistry } from '../../services/validation/ValidationRegistry.js';
import {
  PaginationService,
  FilterService,
  SortService,
  ElementQueryService,
} from '../../services/query/index.js';
import { logger } from '../../utils/logger.js';
import { StartupTimer } from '../../telemetry/StartupTimer.js';
import type { DiContainerFacade } from '../DiContainerFacade.js';

export class CoreInfraServiceRegistrar {
  public register(container: DiContainerFacade): void {
    // Issue #706: Startup timing instrumentation
    container.register('StartupTimer', () => new StartupTimer());

    // CORE & CACHING
    container.register('CacheMemoryBudget', () => new CacheMemoryBudget({
      globalLimitBytes: getValidatedGlobalCacheMemoryBytes(),
    }));
    container.register('APICache', () => new APICache());
    container.register('RateLimitTracker', () => new Map<string, number[]>());
    container.register('FileLockManager', () => new FileLockManager());
    container.register('FileOperationsService', () => new FileOperationsService(container.resolve('FileLockManager')));
    container.register<IStorageLayerFactory>('StorageLayerFactory', () => new FileStorageLayerFactory(
      container.resolve('FileOperationsService'),
      { indexDebounceMs: getValidatedIndexDebounce(), fileFilter: defaultMemoryFileFilter },
    ));
    container.register('ConfigManager', () => new ConfigManager(
      container.resolve('FileOperationsService'),
      os,
      container.hasRegistration('PathService')
        ? container.resolve<import('../../paths/PathService.js').PathService>('PathService').resolveDataDir('config')
        : undefined,
    ));
    // Issue #51: Generic retention policy service with strategy pattern
    container.register('RetentionPolicyService', () => {
      const service = new RetentionPolicyService(container.resolve('ConfigManager'));
      // Register memory retention strategy (first of potentially 50+ element types)
      service.registerStrategy(new MemoryRetentionStrategy());
      return service;
    });
    container.register('IndexConfigManager', () => new IndexConfigManager());
    container.register('IndicatorConfig', () => loadIndicatorConfig());
    container.register('StateChangeNotifier', () => new StateChangeNotifier());
    container.register('MCPLogger', () => logger);

    // SERVICES
    container.register('SerializationService', () => new SerializationService());
    container.register('MetadataService', () => new MetadataService());
    container.register('TriggerValidationService', () => new TriggerValidationService());
    container.register('ValidationService', () => new ValidationService());
    container.register('FileWatchService', () => new FileWatchService());
    container.register('ValidationRegistry', () => new ValidationRegistry(
      container.resolve('ValidationService'),
      container.resolve('TriggerValidationService'),
      container.resolve('MetadataService')
    ));

    // QUERY SERVICES (Issue #38: Pagination, filtering, sorting)
    // These services are element-agnostic and can be used with any element type
    container.register('PaginationService', () => new PaginationService());
    container.register('FilterService', () => new FilterService());
    container.register('SortService', () => new SortService());
    container.register('ElementQueryService', () => new ElementQueryService(
      container.resolve<PaginationService>('PaginationService'),
      container.resolve<FilterService>('FilterService'),
      container.resolve<SortService>('SortService')
    ));
  }
}
