import { ConsoleClient } from './ConsoleClient.js';
import { forgeAdminElevated, forgeAdminUnelevated, forgeUser } from './forgeSession.js';
import { seedWorld, type SeededWorld } from './seed.js';

export interface WorldClients {
  /** No session — for 401 / public-endpoint assertions. */
  readonly anon: ConsoleClient;
  /** Normal user (console:self). */
  readonly userA: ConsoleClient;
  /** Second normal user — for cross-user isolation. */
  readonly userB: ConsoleClient;
  /** Admin, authenticated but NOT stepped-up. */
  readonly adminUnelevated: ConsoleClient;
  /** Admin, fully elevated (admin_5m / admin_30m satisfied). */
  readonly admin: ConsoleClient;
}

export interface World extends SeededWorld {
  readonly clients: WorldClients;
}

/**
 * Seed the principals and forge a session/client per tier. Call in `beforeAll`.
 * Serial execution (the suite runs `--runInBand`) keeps the shared DB clean
 * between files.
 */
export async function setupWorld(): Promise<World> {
  const seeded = await seedWorld();
  const [userA, userB, adminUnelevated, admin] = await Promise.all([
    forgeUser(seeded.userA),
    forgeUser(seeded.userB),
    forgeAdminUnelevated(seeded.admin),
    forgeAdminElevated(seeded.admin),
  ]);
  return {
    ...seeded,
    clients: {
      anon: ConsoleClient.anonymous(),
      userA: ConsoleClient.forSession(userA),
      userB: ConsoleClient.forSession(userB),
      adminUnelevated: ConsoleClient.forSession(adminUnelevated),
      admin: ConsoleClient.forSession(admin),
    },
  };
}
