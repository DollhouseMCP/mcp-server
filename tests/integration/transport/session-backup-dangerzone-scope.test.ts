/**
 * HTTP session BackupService and DangerZoneEnforcer scoping
 *
 * Step 4 regression coverage: root element managers stay shared, but their
 * user-scoped collaborators are resolved at call time from the active
 * SessionContainer.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createHttpTestEnvironment,
  connectHttpClient,
  create,
  update,
  type HttpTestEnvironment,
  type HttpClientHandle,
} from '../../helpers/httpTransportHelper.js';
import type { IUserPathResolver } from '../../../src/paths/IUserPathResolver.js';
import type { SessionContainerRegistry } from '../../../src/di/SessionContainerRegistry.js';
import type { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';

const ENV_STARTUP_TIMEOUT = 20_000;
const TEST_TIMEOUT = 45_000;
const USER_A = 'alice';
const USER_B = 'bob';

async function findFiles(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

async function eventually<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    last = await read();
  }
  return last;
}

describe('HTTP session BackupService and DangerZoneEnforcer scoping', () => {
  let env: HttpTestEnvironment;
  let handleA: HttpClientHandle;
  let handleB: HttpClientHandle;
  let pathResolver: IUserPathResolver;

  beforeAll(async () => {
    env = await createHttpTestEnvironment({
      userIdSequence: [USER_A, USER_B],
    });
    pathResolver = env.container.resolve<IUserPathResolver>('UserPathResolver');
    handleA = await connectHttpClient(env.runtime);
    handleB = await connectHttpClient(env.runtime);
  }, ENV_STARTUP_TIMEOUT);

  afterAll(async () => {
    await handleA?.disconnect();
    await handleB?.disconnect();
    await env?.cleanup();
  });

  it('writes edit backups to the active HTTP user backup root', async () => {
    await create(handleA.client, {
      operation: 'create_element',
      params: {
        element_name: 'step-four-alice',
        element_type: 'persona',
        description: 'Alice original',
        instructions: 'Alice original instructions',
      },
    });
    await update(handleA.client, {
      operation: 'edit_element',
      params: {
        element_name: 'step-four-alice',
        element_type: 'persona',
        input: { description: 'Alice edited' },
      },
    });

    await create(handleB.client, {
      operation: 'create_element',
      params: {
        element_name: 'step-four-bob',
        element_type: 'persona',
        description: 'Bob original',
        instructions: 'Bob original instructions',
      },
    });
    await update(handleB.client, {
      operation: 'edit_element',
      params: {
        element_name: 'step-four-bob',
        element_type: 'persona',
        input: { description: 'Bob edited' },
      },
    });

    const aliceBackups = await findFiles(pathResolver.getUserBackupsDir(USER_A));
    const bobBackups = await findFiles(pathResolver.getUserBackupsDir(USER_B));

    expect(aliceBackups.some(file => file.includes('step-four-alice.backup-'))).toBe(true);
    expect(aliceBackups.some(file => file.includes('step-four-bob.backup-'))).toBe(false);
    expect(bobBackups.some(file => file.includes('step-four-bob.backup-'))).toBe(true);
    expect(bobBackups.some(file => file.includes('step-four-alice.backup-'))).toBe(false);
  }, TEST_TIMEOUT);

  it('persists danger-zone blocks under the active HTTP user security root', async () => {
    const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const childA = registry.get(env.sessionContexts[0].sessionId);
    const childB = registry.get(env.sessionContexts[1].sessionId);
    expect(childA).toBeDefined();
    expect(childB).toBeDefined();

    await create(handleA.client, {
      operation: 'beetlejuice_beetlejuice_beetlejuice',
      params: { agent_name: 'step-four-danger-agent' },
    });

    const aliceSecurityFile = path.join(pathResolver.getUserSecurityDir(USER_A), 'blocked-agents.json');
    const bobSecurityFile = path.join(pathResolver.getUserSecurityDir(USER_B), 'blocked-agents.json');

    const alicePersisted = await eventually(
      async () => fs.readFile(aliceSecurityFile, 'utf8').catch(() => ''),
      content => content.includes('step-four-danger-agent'),
    );
    const bobPersisted = await fs.readFile(bobSecurityFile, 'utf8').catch(() => '');

    expect(alicePersisted).toContain('step-four-danger-agent');
    expect(bobPersisted).not.toContain('step-four-danger-agent');
    expect(childA!.resolve<DangerZoneEnforcer>('DangerZoneEnforcer').check('step-four-danger-agent').blocked).toBe(true);
    expect(childB!.resolve<DangerZoneEnforcer>('DangerZoneEnforcer').check('step-four-danger-agent').blocked).toBe(false);
  }, TEST_TIMEOUT);
});
