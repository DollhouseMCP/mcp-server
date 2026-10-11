import { describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { SessionActivationRegistry } from '../../../src/state/SessionActivationState.js';
import { createUserIdResolver } from '../../../src/database/UserContext.js';
import { IdentityHandler } from '../../../src/handlers/IdentityHandler.js';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';
import type { InitializationService } from '../../../src/services/InitializationService.js';
import type { PersonaIndicatorService } from '../../../src/services/PersonaIndicatorService.js';

function fixture(transport: 'http' | 'stdio' = 'http') {
  const tracker = new ContextTracker(); const tenant = randomUUID(); const other = randomUUID();
  const sessionId = randomUUID(); const registry = new SessionActivationRegistry(sessionId);
  const context = tracker.createSessionContext('test', { userId:tenant, sessionId,tenantId:null,transport,createdAt:1 });
  return {tracker,tenant,other,sessionId,registry,context};
}
describe('configured authenticated HTTP database authority', () => {
  it('pins the actual signed session UUID and refuses an attribution override without changing it', () => {
    const f = fixture(); const resolve = createUserIdResolver(f.tracker,f.registry,true);
    f.tracker.run(f.context, () => {
      expect(resolve()).toBe(f.tenant);
      f.registry.getOrCreate(f.sessionId).dbUserId=f.other;
      expect(resolve).toThrow('differs from the authenticated HTTP subject');
      expect(f.context.session!.userId).toBe(f.tenant);
      f.registry.getOrCreate(f.sessionId).dbUserId=f.tenant; expect(resolve()).toBe(f.tenant);
    });
  });
  it('preserves the ordinary local stdio attribution override', () => {
    const f = fixture('stdio'); f.registry.getOrCreate(f.sessionId).dbUserId=f.other;
    const resolve = createUserIdResolver(f.tracker,f.registry,true);
    f.tracker.run(f.context, () => expect(resolve()).toBe(f.other));
  });
  it.each(['set','clear'])('refuses HTTP attribution %s before initialization, persona mutation or user lookup', async method => {
    const f = fixture();
    const persona = { setUserIdentity:jest.fn(),clearUserIdentity:jest.fn() };
    const ensureInitialized = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const handler = new IdentityHandler(persona as unknown as PersonaManager,
      {ensureInitialized} as unknown as InitializationService,{} as PersonaIndicatorService,f.tracker,true);
    await f.tracker.runAsync(f.context, async () => {
      await expect(method==='set' ? handler.setUserIdentity('other-user') : handler.clearUserIdentity()).rejects.toThrow('cannot be changed');
    });
    expect(ensureInitialized).not.toHaveBeenCalled(); expect(persona.setUserIdentity).not.toHaveBeenCalled();
    expect(persona.clearUserIdentity).not.toHaveBeenCalled(); expect(f.registry.get(f.sessionId)?.dbUserId).toBeUndefined();
  });
});
