/**
 * ObservabilityServiceRegistrar
 *
 * Owns the DI wiring for logging, metrics, telemetry, and performance
 * monitoring. These services are cross-cutting and instrumentation-only —
 * they observe the system without altering its core behavior.
 *
 * Responsibilities:
 * - LogManager (with MemoryLogSink side-effect registration inside its factory)
 * - MemoryMetricsSink (conditional on metrics being enabled)
 * - MetricsManager (conditional on metrics being enabled)
 * - OperationalTelemetry
 * - PerformanceMonitor (with startMonitoring())
 * - OperationMetricsTracker, GatekeeperMetricsTracker
 * - CircuitBreakerState, ResilienceMetricsTracker
 *
 * Note: BuildInfoService is kept in Container.ts because it references
 * `this.deferredSetupComplete` — a Container-internal property that cannot
 * be passed through the DiContainerFacade.
 *
 * @module di/registrars/ObservabilityServiceRegistrar
 */

import { PACKAGE_VERSION } from '../../generated/version.js';
import { env } from '../../config/env.js';
import { PerformanceMonitor } from '../../utils/PerformanceMonitor.js';
import { OperationalTelemetry } from '../../telemetry/OperationalTelemetry.js';
import { CircuitBreakerState } from '../../elements/agents/resilienceEvaluator.js';
import { ResilienceMetricsTracker } from '../../elements/agents/resilienceMetrics.js';
import { LogManager, buildLogManagerConfig } from '../../logging/LogManager.js';
import { FileLogSink } from '../../logging/sinks/FileLogSink.js';
import { MemoryLogSink } from '../../logging/sinks/MemoryLogSink.js';
import { PlainTextFormatter } from '../../logging/formatters/PlainTextFormatter.js';
import { JsonlFormatter } from '../../logging/formatters/JsonlFormatter.js';
import { MetricsManager } from '../../metrics/MetricsManager.js';
import { MemoryMetricsSink } from '../../metrics/sinks/MemoryMetricsSink.js';
import { buildMetricsManagerConfig } from '../../metrics/types.js';
import { OperationMetricsTracker } from '../../metrics/OperationMetricsTracker.js';
import { GatekeeperMetricsTracker } from '../../metrics/GatekeeperMetricsTracker.js';
import { logger } from '../../utils/logger.js';
import type { DiContainerFacade } from '../DiContainerFacade.js';

export class ObservabilityServiceRegistrar {
  public register(container: DiContainerFacade): void {
    // LOGGING
    container.register('LogManager', () => {
      const config = buildLogManagerConfig(env);
      const manager = new LogManager(config);

      // Phase 2: FileLogSink
      const formatter = config.logFormat === 'jsonl'
        ? new JsonlFormatter()
        : new PlainTextFormatter();
      const fileSink = new FileLogSink({
        logDir: config.logDir,
        formatter,
        maxFileSize: config.fileMaxSize,
        retentionDays: config.retentionDays,
        securityRetentionDays: config.securityRetentionDays,
        maxDirSizeBytes: config.maxDirSizeBytes,
        maxFilesPerCategory: config.maxFilesPerCategory,
      });
      manager.registerSink(fileSink);
      fileSink.startCleanupTimer();

      // Phase 3: MemoryLogSink
      const memorySink = new MemoryLogSink({
        appCapacity: config.memoryAppCapacity,
        securityCapacity: config.memorySecurityCapacity,
        perfCapacity: config.memoryPerfCapacity,
        telemetryCapacity: config.memoryTelemetryCapacity,
      });
      manager.registerSink(memorySink);

      container.register('MemoryLogSink', () => memorySink);

      // Startup marker — first entry in every server session
      manager.log({
        id: manager.generateId(),
        timestamp: new Date().toISOString(),
        category: 'application',
        level: 'info',
        source: 'DollhouseMCP',
        message: `DollhouseMCP v${PACKAGE_VERSION} starting`,
        data: {
          version: PACKAGE_VERSION,
          logLevel: config.logLevel,
          logFormat: config.logFormat,
          console: env.DOLLHOUSE_WEB_CONSOLE
            ? `http://dollhouse.localhost:${env.DOLLHOUSE_WEB_CONSOLE_PORT}`
            : 'disabled',
        },
      });

      return manager;
    });

    // METRICS COLLECTION
    // MemoryMetricsSink is registered separately (not as a side effect inside
    // MetricsManager's factory) so it's available in the container regardless
    // of MetricsManager resolution order.
    const metricsConfig = buildMetricsManagerConfig(env);
    if (metricsConfig.enabled) {
      const memoryMetricsSink = new MemoryMetricsSink(metricsConfig.memorySnapshotCapacity);
      container.register('MemoryMetricsSink', () => memoryMetricsSink);

      container.register('MetricsManager', () => {
        const manager = new MetricsManager(metricsConfig, logger);
        manager.registerSink(memoryMetricsSink);
        return manager;
      });
    }

    // TELEMETRY
    container.register('OperationalTelemetry', () => new OperationalTelemetry(
      container.resolve('FileOperationsService'),
      container.hasRegistration('PathService')
        ? container.resolve<import('../../paths/PathService.js').PathService>('PathService').resolveDataDir('state')
        : undefined,
    ));

    container.register('PerformanceMonitor', () => {
      const monitor = new PerformanceMonitor();
      monitor.startMonitoring();
      return monitor;
    });

    container.register('OperationMetricsTracker', () => new OperationMetricsTracker());
    container.register('GatekeeperMetricsTracker', () => new GatekeeperMetricsTracker());

    // Resilience: DI-managed instances (moved from module-level singletons)
    container.register('CircuitBreakerState', () => new CircuitBreakerState());
    container.register('ResilienceMetricsTracker', () => new ResilienceMetricsTracker());
  }
}
