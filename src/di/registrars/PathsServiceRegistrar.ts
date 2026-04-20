/**
 * PathsServiceRegistrar
 *
 * Owns the DI wiring for the `src/paths/` module — resolver, per-user
 * layout backend, package resource locator, and the unified `PathService`
 * facade. Runs in every deployment (file and DB modes alike), since
 * path resolution is a universal infrastructure concern.
 *
 * Responsibilities:
 * - Detect flat-vs-per-user layout at startup via
 *   `LegacyDetectingPathResolver.detect()`.
 * - Register `PackageResourceLocator`, `IUserPathResolver`, and
 *   `PathService` as root-scoped singletons.
 * - Register `UserIdResolver` if not already registered by
 *   `DatabaseServiceRegistrar` — file mode needs it too.
 *
 * Consumers inject `PathService` rather than calling the underlying
 * resolvers directly. This keeps the path infrastructure swappable
 * (layout wrong? swap the resolver) without disturbing consumers.
 *
 * @module di/registrars/PathsServiceRegistrar
 */

import * as os from 'node:os';
import path from 'node:path';

import type { IUserPathResolver } from '../../paths/IUserPathResolver.js';
import { LegacyDetectingPathResolver } from '../../paths/LegacyDetectingPathResolver.js';
import { PackageResourceLocator } from '../../paths/PackageResourceLocator.js';
import { PathService, type UserIdResolver } from '../../paths/PathService.js';
import {
  resolveDataDirectory,
  type ResolveOptions,
} from '../../paths/resolveDataDirectory.js';
import type { ContextTracker } from '../../security/encryption/ContextTracker.js';
import type { DiContainerFacade } from '../DiContainerFacade.js';

// Re-export for callers that locate the facade through the registrar.
export type { DiContainerFacade } from '../DiContainerFacade.js';

export class PathsServiceRegistrar {
  /**
   * Detect layout and register all path services with the container.
   *
   * Must be called during startup, after `ContextTracker` is registered
   * but before any consumer tries to resolve `PathService`.
   */
  public async bootstrapAndRegister(container: DiContainerFacade): Promise<void> {
    // The UserIdResolver factory registered below resolves ContextTracker
    // lazily. If ContextTracker isn't registered by the time
    // `PathService.getUserXxxDir()` is first called, the error surfaces
    // as a confusing "service ContextTracker not registered" deep in a
    // path resolution call. Fail loudly at registrar time instead.
    if (!container.hasRegistration('ContextTracker')) {
      throw new Error(
        'PathsServiceRegistrar: ContextTracker must be registered before path services. ' +
        'Call container.register(\'ContextTracker\', ...) first.'
      );
    }

    // `homeDir` and `portfolioRoot` are captured at bootstrap and
    // become stable anchors for the process lifetime — changing them
    // mid-run would invalidate every per-user path already in flight.
    // This is an intentional asymmetry with `DOLLHOUSE_*_DIR` env vars,
    // which `resolveDataDirectory` re-reads on every call so operators
    // can rotate app-internal paths (cache, logs, state) at runtime.
    // Portfolio anchors are identity-bearing; rotating them at runtime
    // would strand users' data.
    const homeDirEnv = process.env.DOLLHOUSE_HOME_DIR?.trim();
    if (homeDirEnv !== undefined && homeDirEnv.length > 0 && !path.isAbsolute(homeDirEnv)) {
      throw new Error(
        `DOLLHOUSE_HOME_DIR must be an absolute path, got ${homeDirEnv}`
      );
    }
    const homeDir = (homeDirEnv && homeDirEnv.length > 0) ? homeDirEnv : os.homedir();
    const legacyRoot = path.join(homeDir, '.dollhouse');
    const portfolioRoot = resolveDataDirectory('portfolio-root', {
      platform: process.platform,
      homeDir,
      env: process.env,
    });

    // `portfolioRoot` is only used on the fresh-install branch inside
    // detect(); when a legacy install is present, the returned
    // resolver anchors on `legacyRoot`. Both are passed so detect()
    // does not need to re-derive either from process state.
    const userPathResolver = await LegacyDetectingPathResolver.detect({
      legacyRoot,
      portfolioRoot,
    });

    // Build the shared ResolveOptions applied to every resolveDataDir
    // call. When the detected anchor matches the legacy root, all
    // app-internal paths resolve under it (byte-identical to
    // pre-Step-4.5 layout). Otherwise platform-correct defaults apply.
    //
    // `env` is deliberately NOT captured here — resolveDataDirectory
    // re-reads `process.env` on every call so operators can rotate
    // DOLLHOUSE_*_DIR env vars at runtime without restarting.
    const anchorRoot = userPathResolver.getAnchorRoot();
    const resolvedLegacy = path.resolve(legacyRoot);
    const dataDirectoryOptions: Partial<ResolveOptions> = {
      platform: process.platform,
      homeDir,
      legacyRoot: anchorRoot === resolvedLegacy ? resolvedLegacy : undefined,
    };

    container.register('PackageResourceLocator', () => new PackageResourceLocator());
    container.register<IUserPathResolver>('UserPathResolver', () => userPathResolver);

    // Ensure a UserIdResolver is available. DatabaseServiceRegistrar
    // registers a UUID-validating resolver in DB mode; in file mode we
    // register a simpler ContextTracker-backed resolver here.
    if (!container.hasRegistration('UserIdResolver')) {
      container.register<UserIdResolver>('UserIdResolver', () => {
        const tracker = container.resolve<ContextTracker>('ContextTracker');
        return () => {
          const session = tracker.getSessionContext();
          if (!session?.userId) {
            throw new Error(
              'PathService: no active session context. Per-user path resolution must ' +
              'run inside ContextTracker.runAsync() — stdio wires this at startup, HTTP ' +
              'wires it per request. A missing context usually means the operation was ' +
              'invoked from a background task or test harness that forgot to establish one.'
            );
          }
          return session.userId;
        };
      });
    }

    container.register<PathService>('PathService', () => new PathService({
      userResolver: container.resolve<IUserPathResolver>('UserPathResolver'),
      packageLocator: container.resolve<PackageResourceLocator>('PackageResourceLocator'),
      userIdResolver: container.resolve<UserIdResolver>('UserIdResolver'),
      dataDirectoryOptions,
    }));
  }
}
