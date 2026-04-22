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
import { SecurityTelemetry } from '../../security/telemetry/SecurityTelemetry.js';
import { TokenManager } from '../../security/tokenManager.js';
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
      container.resolve('FileOperationsService')
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
      if (container.hasRegistration('DatabaseInstance')) {
        const db = container.resolve<DatabaseInstance>('DatabaseInstance');
        const userId = container.resolve<string>('CurrentUserId');
        const DbStore = container.resolve<typeof DatabaseConfirmationStore>('DatabaseConfirmationStoreClass');
        return new DbStore(db, userId, session.sessionId);
      }
      return new FileConfirmationStore(
        container.resolve('FileOperationsService'),
        undefined,
        session.sessionId
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
}
