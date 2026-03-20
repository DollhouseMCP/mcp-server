import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { IdentityHandler } from '../../../src/handlers/IdentityHandler.js';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';
import type { InitializationService } from '../../../src/services/InitializationService.js';
import type { PersonaIndicatorService } from '../../../src/services/PersonaIndicatorService.js';

describe('IdentityHandler', () => {
  let handler: IdentityHandler;
  let personaManager: jest.Mocked<
    Pick<
      PersonaManager,
      'setUserIdentity' | 'getUserIdentity' | 'clearUserIdentity' | 'getCurrentUserForAttribution'
    >
  >;
  let initService: jest.Mocked<Pick<InitializationService, 'ensureInitialized'>>;
  let indicatorService: jest.Mocked<Pick<PersonaIndicatorService, 'getPersonaIndicator'>>;

  let personaState: { username: string | null; email: string | null };
  let anonCounter: number;

  beforeEach(() => {
    personaState = { username: null, email: null };
    anonCounter = 0;

    delete process.env.DOLLHOUSE_USER;
    delete process.env.DOLLHOUSE_EMAIL;

    personaManager = {
      setUserIdentity: jest.fn((username: string | null, email?: string) => {
        personaState.username = username;
        personaState.email = email ?? null;

        if (username) {
          process.env.DOLLHOUSE_USER = username;
        } else {
          delete process.env.DOLLHOUSE_USER;
        }

        if (email) {
          process.env.DOLLHOUSE_EMAIL = email;
        } else {
          delete process.env.DOLLHOUSE_EMAIL;
        }
      }),
      getUserIdentity: jest.fn(() => ({
        username: personaState.username,
        email: personaState.email,
      })),
      clearUserIdentity: jest.fn(() => {
        personaState.username = null;
        personaState.email = null;
        delete process.env.DOLLHOUSE_USER;
        delete process.env.DOLLHOUSE_EMAIL;
      }),
      getCurrentUserForAttribution: jest.fn(() => {
        if (personaState.username) {
          return personaState.username;
        }
        anonCounter += 1;
        return `anon-generated-${anonCounter}`;
      }),
    };

    initService = {
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
    };
    indicatorService = {
      getPersonaIndicator: jest.fn().mockReturnValue('>>'),
    };

    handler = new IdentityHandler(
      personaManager as unknown as PersonaManager,
      initService as unknown as InitializationService,
      indicatorService as unknown as PersonaIndicatorService
    );
  });

  describe('setUserIdentity', () => {
    it('sets a valid username', async () => {
      const result = await handler.setUserIdentity('test-user');

      expect(initService.ensureInitialized).toHaveBeenCalled();
      expect(personaManager.setUserIdentity).toHaveBeenCalledWith('test-user', undefined);
      expect(result.content[0].text).toContain('>>');
      expect(result.content[0].text).toContain('User Identity Set');
      expect(result.content[0].text).toContain('test-user');
    });

    it('sets username and email', async () => {
      const result = await handler.setUserIdentity('test-user', 'test@example.com');

      expect(personaManager.setUserIdentity).toHaveBeenCalledWith('test-user', 'test@example.com');
      expect(process.env.DOLLHOUSE_EMAIL).toBe('test@example.com');
      expect(result.content[0].text).toContain('test@example.com');
    });

    it('rejects empty username', async () => {
      const result = await handler.setUserIdentity('');

      expect(personaManager.setUserIdentity).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Username cannot be empty');
    });

    it('rejects invalid email format', async () => {
      const result = await handler.setUserIdentity('test-user', 'not-an-email');

      expect(personaManager.setUserIdentity).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Validation Error');
      expect(result.content[0].text).toContain('Invalid email format');
    });

    it('shows environment variable instructions', async () => {
      const result = await handler.setUserIdentity('test-user');
      expect(result.content[0].text).toContain('DOLLHOUSE_USER=test-user');
    });
  });

  describe('getUserIdentity', () => {
    it('returns anonymous status when no user is set', async () => {
      const result = await handler.getUserIdentity();

      expect(initService.ensureInitialized).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Anonymous');
      expect(result.content[0].text).toContain('set_user_identity "your-username"');
    });

    it('returns username and email when set', async () => {
      personaState = { username: 'test-user', email: 'test@example.com' };
      const result = await handler.getUserIdentity();

      expect(result.content[0].text).toContain('test-user');
      expect(result.content[0].text).toContain('test@example.com');
    });
  });

  describe('clearUserIdentity', () => {
    it('clears user identity when set', async () => {
      personaState = { username: 'test-user', email: 'test@example.com' };

      const result = await handler.clearUserIdentity();

      expect(personaManager.clearUserIdentity).toHaveBeenCalled();
      expect(result.content[0].text).toContain('User Identity Cleared');
      expect(result.content[0].text).toContain('Anonymous mode');
    });

    it('handles already anonymous state', async () => {
      const result = await handler.clearUserIdentity();

      expect(result.content[0].text).toContain('Already in Anonymous Mode');
    });
  });

  describe('getCurrentUserForAttribution', () => {
    it('returns username when set', () => {
      personaState.username = 'test-user';

      const result = handler.getCurrentUserForAttribution();

      expect(result).toBe('test-user');
    });

    it('returns anonymous id when not set', () => {
      const result1 = handler.getCurrentUserForAttribution();
      const result2 = handler.getCurrentUserForAttribution();

      expect(result1).toMatch(/^anon-generated-/);
      expect(result2).toMatch(/^anon-generated-/);
      expect(result1).not.toEqual(result2);
    });
  });
});
