/**
 * SecurityServiceRegistrar
 *
 * Owns the DI wiring for the security subsystem: session management,
 * encryption, pattern validation, token management, path enforcement,
 * and per-session state stores.
 *
 * Responsibilities:
 * - SecurityMonitor (eager resolve + static wiring)
 * - StdioSession, SessionActivationRegistry, ContextTracker
 * - PatternEncryptor, PatternDecryptor, PatternExtractor
 * - BackgroundValidator, SecurityTelemetry, TokenManager
 * - PathValidator (+ PathValidator.setRootInstance())
 * - DangerZoneEnforcer
 * - ActivationStore, ConfirmationStore, ChallengeStore, VerificationStore alias
 * - VerificationNotifier
 * - Static wiring: MetadataService.configureSessionAwareness()
 * - Static wiring: ContentValidator.configureTelemetryResolver()
 *
 * @module di/registrars/SecurityServiceRegistrar
 */

import { createStdioSession } from '../../context/StdioSession.js';
import { ContextTracker } from '../../security/encryption/ContextTracker.js';
import { PatternEncryptor } from '../../security/encryption/PatternEncryptor.js';
import { PatternDecryptor } from '../../security/encryption/PatternDecryptor.js';
import { PatternExtractor } from '../../security/validation/PatternExtractor.js';
import { BackgroundValidator } from '../../security/validation/BackgroundValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import { SecurityTelemetry } from '../../security/telemetry/SecurityTelemetry.js';
import { TokenManager } from '../../security/tokenManager.js';
import type { ITokenStore } from '../../security/tokenStores/ITokenStore.js';
import { PathValidator } from '../../security/pathValidator.js';
import { DangerZoneEnforcer } from '../../security/DangerZoneEnforcer.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { SessionActivationRegistry } from '../../state/SessionActivationState.js';
import { FileActivationStateStore } from '../../state/FileActivationStateStore.js';
import { FileConfirmationStore } from '../../state/FileConfirmationStore.js';
import { InMemoryChallengeStore } from '../../state/InMemoryChallengeStore.js';
import type { DatabaseActivationStateStore } from '../../state/DatabaseActivationStateStore.js';
import type { DatabaseConfirmationStore } from '../../state/DatabaseConfirmationStore.js';
import type { DatabaseChallengeStore } from '../../state/DatabaseChallengeStore.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { VerificationNotifier } from '../../services/VerificationNotifier.js';
import { PortfolioManager, ElementType } from '../../portfolio/PortfolioManager.js';
import type { MetadataService } from '../../services/MetadataService.js';
import type { DiContainerFacade } from '../DiContainerFacade.js';
import path from 'node:path';
import { AuditHmacKeyResolver } from '../../security/auditHmacKey.js';
import type { AuditHmacResolver } from '../../security/toolRedaction.js';
import { warnAuditRawInputDefaultIfNeeded } from '../../security/auditStartupWarning.js';
import type { PathService } from '../../paths/PathService.js';

export class SecurityServiceRegistrar {
  public register(container: DiContainerFacade): void {
    // SecurityMonitor: DI-managed instance wired into the static facade.
    // Eagerly resolved to replace the fallback before handlers start logging.
    container.register('SecurityMonitor', () => {
      const instance = new SecurityMonitor();
      SecurityMonitor.setInstance(instance);
      return instance;
    });
    container.resolve('SecurityMonitor');

    // Shared stdio session — single source of truth for session identity.
    // In file-mode and when no DB is bootstrapped, `createStdioSession()` uses
    // DOLLHOUSE_USER / OS username. When database mode is active,
    // `preparePortfolio()` re-registers this service with the bootstrapped DB
    // UUID as userId so SessionContext carries an RLS-valid identity.
    container.register('StdioSession', () => createStdioSession());

    // Issue #1946: Session activation registry — maps sessionId → SessionActivationState
    container.register('SessionActivationRegistry', () => {
      const session = container.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
      return new SessionActivationRegistry(session.sessionId);
    });

    container.register('ContextTracker', () => new ContextTracker());

    container.register('PatternEncryptor', () => new PatternEncryptor());
    container.register('PatternDecryptor', () => new PatternDecryptor(
      container.resolve('PatternEncryptor'),
      container.resolve('ContextTracker')
    ));
    container.register('PatternExtractor', () => new PatternExtractor(
      container.resolve('PatternEncryptor')
    ));
    container.register('BackgroundValidator', () => new BackgroundValidator(
      container.resolve('PatternExtractor'),
      container.resolve('MemoryManager')
    ));
    container.register('SecurityTelemetry', () => new SecurityTelemetry());

    container.register('TokenManager', () => new TokenManager(
      () => container.resolve<ITokenStore>('TokenStore'),
      () => container.resolve<() => string>('UserIdResolver')()
    ));

    // Issue #1948: PathValidator as DI-managed singleton (replaces static class state)
    container.register('PathValidator', () => {
      const personasDir = container.resolve<PortfolioManager>('PortfolioManager')
        .getElementDir(ElementType.PERSONA);
      const instance = new PathValidator(personasDir);
      PathValidator.setRootInstance(instance);
      return instance;
    });

    // Issue #402: DangerZoneEnforcer as DI-managed singleton (replaces module-level singleton)
    container.register('DangerZoneEnforcer', () => new DangerZoneEnforcer(
      container.resolve('FileOperationsService')
    ));

    // Issue #598, #1945, #1886: Per-session state stores — database or file-backed.
    // hasRegistration check is inside each lambda so it evaluates at resolution time,
    // allowing DatabaseInstance to be registered after the container is constructed
    // (e.g., by HTTP transport lazy bootstrap).
    container.register('ActivationStore', () => {
      const session = container.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
      if (container.hasRegistration('DatabaseInstance')) {
        const db = container.resolve<DatabaseInstance>('DatabaseInstance');
        const userId = container.resolve<string>('CurrentUserId');
        const DbStore = container.resolve<typeof DatabaseActivationStateStore>('DatabaseActivationStateStoreClass');
        return new DbStore(db, userId, session.sessionId);
      }
      return new FileActivationStateStore(
        container.resolve('FileOperationsService'),
        undefined,
        session.sessionId
      );
    });

    container.register('ConfirmationStore', () => {
      const session = container.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
      const resolver = container.hasRegistration('AuditHmacResolver')
        ? container.resolve<AuditHmacResolver>('AuditHmacResolver')
        : undefined;
      if (container.hasRegistration('DatabaseInstance')) {
        const db = container.resolve<DatabaseInstance>('DatabaseInstance');
        const userId = container.resolve<string>('CurrentUserId');
        const DbStore = container.resolve<typeof DatabaseConfirmationStore>('DatabaseConfirmationStoreClass');
        return new DbStore(db, userId, session.sessionId, resolver);
      }
      // Resolve state dir via PathService so the file store lands on the
      // platform-correct path (XDG / Library / LOCALAPPDATA) instead of
      // the legacy hardcoded ~/.dollhouse/state. PathService is registered
      // by PathsServiceRegistrar during preparePortfolio(), which runs
      // before any consumer resolves 'ConfirmationStore'.
      const pathService = container.resolve<PathService>('PathService');
      return new FileConfirmationStore(
        container.resolve('FileOperationsService'),
        pathService.resolveDataDir('state'),
        session.sessionId,
        resolver
      );
    });

    // Issue #142: ChallengeStore for danger zone challenge codes (server-side)
    // Issue #1945: Wrapped in IChallengeStore interface for backend swappability
    container.register('ChallengeStore', () => {
      if (container.hasRegistration('DatabaseInstance')) {
        const session = container.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
        const db = container.resolve<DatabaseInstance>('DatabaseInstance');
        const userId = container.resolve<string>('CurrentUserId');
        const DbStore = container.resolve<typeof DatabaseChallengeStore>('DatabaseChallengeStoreClass');
        return new DbStore(db, userId, session.sessionId);
      }
      return new InMemoryChallengeStore();
    });

    // Backward-compat alias — existing code resolves 'VerificationStore'
    container.register('VerificationStore', () => container.resolve('ChallengeStore'));

    // Issue #522: Non-blocking OS dialog notifier for verification codes
    container.register('VerificationNotifier', () => new VerificationNotifier());

    // Audit HMAC resolver — process-wide singleton, lazy factory.
    // SecurityServiceRegistrar runs synchronously during the initial
    // registerServices() pass, before preparePortfolio() bootstraps the
    // database registrar. Constructing the resolver here would capture
    // an undefined database and silently route DB-mode deployments
    // through the file backend. The factory below defers the DB lookup
    // to first resolve(); the container's default singleton behavior
    // ensures the factory runs exactly once.
    container.register('AuditHmacResolver', () => {
      const pathService = container.resolve<PathService>('PathService');
      return new AuditHmacKeyResolver({
        database: container.hasRegistration('SystemDatabaseInstance')
          ? container.resolve<DatabaseInstance>('SystemDatabaseInstance')
          : undefined,
        // File-mode key path resolved via PathService so it follows the
        // same legacyRoot / DOLLHOUSE_STATE_DIR overrides the rest of
        // the system honors.
        rootDir: path.join(pathService.resolveDataDir('state'), 'secrets', 'audit-hmac-key'),
      });
    });

    // The audit-retention startup warning probes the same DB and must
    // also wait for the DB registration. Fired from runPostDbWarnings()
    // which Container.preparePortfolio() invokes once the DB is up.

    // Eager wiring — must come AFTER all dependencies above are registered.
    // MetadataService is from CoreInfraServiceRegistrar (runs before this registrar).
    // ContextTracker and SessionActivationRegistry are registered above in this method.
    // Moving these calls above their dependency registrations will cause a runtime error.
    container.resolve<MetadataService>('MetadataService').configureSessionAwareness(
      container.resolve<ContextTracker>('ContextTracker'),
      container.resolve<SessionActivationRegistry>('SessionActivationRegistry'),
    );

    ContentValidator.configureTelemetryResolver(() => container.resolve('SecurityTelemetry'));
  }

  /**
   * Post-DB security warmups. Called after the database registrar has
   * bootstrapped so `SystemDatabaseInstance` is resolvable for the audit
   * retention probe. Safe in file-mode deployments — the probe falls
   * back to scanning the per-session state files.
   */
  public async runPostDbWarnings(container: DiContainerFacade): Promise<void> {
    try {
      // PathService is registered by PathsServiceRegistrar earlier in
      // preparePortfolio(), so the probe can scan the platform-correct
      // state dir instead of falling through to the hardcoded default.
      const pathService = container.resolve<PathService>('PathService');
      await warnAuditRawInputDefaultIfNeeded({
        database: container.hasRegistration('SystemDatabaseInstance')
          ? container.resolve<DatabaseInstance>('SystemDatabaseInstance')
          : undefined,
        stateDir: pathService.resolveDataDir('state'),
      });
    } catch (err) {
      // The warning is best-effort — a probe failure must not abort startup,
      // but the cause is worth keeping at debug level so an operator who
      // chases "why didn't I see the audit retention warning?" has a trail.
      logger.debug('[SecurityServiceRegistrar] runPostDbWarnings probe failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
