/**
 * ServerServiceRegistrar
 *
 * Owns the DI wiring for the MCP server lifecycle services: ServerSetup
 * (which binds session resolution to the transport) and ServerStartup
 * (which coordinates the critical-path initialization sequence).
 *
 * Responsibilities:
 * - ServerSetup (with StdioSession-based SessionResolver)
 * - ServerStartup
 *
 * @module di/registrars/ServerServiceRegistrar
 */

import { createStdioSession } from '../../context/StdioSession.js';
import { ContextTracker } from '../../security/encryption/ContextTracker.js';
import type { SessionResolver } from '../../context/SessionContext.js';
import { ServerSetup } from '../../server/index.js';
import { ServerStartup } from '../../server/startup.js';
import type { DiContainerFacade } from '../DiContainerFacade.js';

export class ServerServiceRegistrar {
  public register(container: DiContainerFacade): void {
    // SERVER
    container.register('ServerSetup', () => {
      const stdioSession = container.resolve<ReturnType<typeof createStdioSession>>('StdioSession');
      const sessionResolver: SessionResolver = () => stdioSession;
      return new ServerSetup(
        container.resolve<ContextTracker>('ContextTracker'),
        sessionResolver,
      );
    });

    container.register('ServerStartup', () => new ServerStartup(
      container.resolve('PortfolioManager'),
      container.resolve('FileLockManager'),
      container.resolve('ConfigManager'),
      container.resolve('MigrationManager'),
      container.resolve('MemoryManager'),
      container.resolve('OperationalTelemetry')
    ));
  }
}
