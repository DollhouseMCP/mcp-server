import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHttpTestEnvironment, connectHttpClient } from '../../helpers/httpTransportHelper.js';
import type { IUserPathResolver } from '../../../src/paths/IUserPathResolver.js';
import type { SessionContainerRegistry } from '../../../src/di/SessionContainerRegistry.js';
import type { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';

async function persisted(owner: DangerZoneEnforcer, file: string, names: string[]) {
  expect(await owner.flush()).toBe(true);
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(Object.keys(data.blocks).sort((left, right) => left.localeCompare(right)))
    .toEqual([...names].sort((left, right) => left.localeCompare(right)));
  return data;
}
describe('HTTP block-state ownership', () => {
  it('loads and shares one user snapshot across sessions', async () => {
    const env = await createHttpTestEnvironment({ userIdSequence: ['alice', 'alice', 'bob'] });
    const handles: Awaited<ReturnType<typeof connectHttpClient>>[] = [];
    try {
      const resolver = env.container.resolve<IUserPathResolver>('UserPathResolver');
      const file = path.join(resolver.getUserSecurityDir('alice'), 'blocked-agents.json');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ version: 1, blocks: { saved: { reason: 'Review required', blockedAt: '2026-01-01', verificationId: 'saved-code' } } }));
      for (let index = 0; index < 3; index++) handles.push(await connectHttpClient(env.runtime));
      const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
      const [first, second, other] = env.sessionContexts.map(context => registry.get(context.sessionId)!.resolve<DangerZoneEnforcer>('DangerZoneEnforcer'));
      expect((await first.check('saved')).verificationId).toBe('saved-code');
      expect(second).toBe(first);
      expect((await other.check('saved')).blocked).toBe(false);
      first.block('a', 'Review required', [], 'a-code', undefined, env.sessionContexts[0].sessionId);
      second.block('b', 'Review required', [], 'b-code', undefined, env.sessionContexts[1].sessionId);
      expect((await second.check('a')).blocked).toBe(true);
      await persisted(first, file, ['a', 'b', 'saved']);
      expect((await second.unblock('a', 'a-code', env.sessionContexts[1].sessionId))).toBe(false);
      expect((await first.unblock('a', 'a-code', env.sessionContexts[0].sessionId))).toBe(true);
      await persisted(first, file, ['b', 'saved']);
      await handles[0].disconnect();
      expect((await second.check('b')).verificationId).toBe('b-code');
      const restarted = await createHttpTestEnvironment({ userIdSequence: ['alice'] });
      try {
        restarted.container.register('UserPathResolver', () => resolver, { override: true });
        const restoredHandle = await connectHttpClient(restarted.runtime);
        try {
          const restoredRegistry = restarted.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
          const restored = restoredRegistry.get(restarted.sessionContexts[0].sessionId)!.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');
          expect((await restored.check('b')).verificationId).toBe('b-code');
          expect((await restored.check('a')).blocked).toBe(false);
        } finally { await restoredHandle.disconnect(); }
      } finally { await restarted.cleanup(); }

    } finally {
      for (const handle of handles) await handle.disconnect();
      await env.cleanup();
    }
  }, 45000);
});
