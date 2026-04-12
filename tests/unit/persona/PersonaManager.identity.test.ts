/**
 * Unit tests for PersonaManager session-aware identity reads (Step 1.5)
 *
 * Tests that getCurrentUserForAttribution() and getUserIdentity() prefer
 * SessionContext when an explicit identity is present, falling back to
 * MetadataService/process.env for default stdio sessions.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: { logSecurityEvent: jest.fn() },
}));

import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { STDIO_DEFAULT_USER_ID } from '../../../src/context/StdioSession.js';
import { SYSTEM_CONTEXT } from '../../../src/context/ContextPolicy.js';
import type { SessionContext } from '../../../src/context/SessionContext.js';
import {
  createMockPortfolioManager,
  createMockValidationRegistry,
} from '../../helpers/di-mocks.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { SerializationService } from '../../../src/services/SerializationService.js';

// MetadataService mock — controls what the fallback chain returns
const mockGetCurrentUser = jest.fn<() => string>().mockReturnValue('os-fallback-user');
const mockSetCurrentUser = jest.fn();
const mockMetadataService = {
  getCurrentUser: mockGetCurrentUser,
  setCurrentUser: mockSetCurrentUser,
};

const mockFileLockManager = { withLock: jest.fn() };
const mockFileOps = {};
const mockIndicatorConfig = {};

// Dynamic import to avoid hoisting issues with mocks
let PersonaManager: any;

beforeAll(async () => {
  const mod = await import('../../../src/persona/PersonaManager.js');
  PersonaManager = mod.PersonaManager;
});

function createPersonaManager(contextTracker?: ContextTracker) {
  return new PersonaManager({
    portfolioManager: createMockPortfolioManager(),
    indicatorConfig: mockIndicatorConfig,
    fileLockManager: mockFileLockManager,
    fileOperationsService: mockFileOps,
    validationRegistry: createMockValidationRegistry(),
    serializationService: new SerializationService(),
    metadataService: mockMetadataService,
    eventDispatcher: new ElementEventDispatcher(),
    contextTracker,
  });
}

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return Object.freeze({
    userId: 'http-user-alice',
    sessionId: 'session-123',
    tenantId: null,
    transport: 'http' as const,
    createdAt: Date.now(),
    ...overrides,
  });
}

describe('PersonaManager — session-aware identity (Step 1.5)', () => {
  let tracker: ContextTracker;

  beforeEach(() => {
    tracker = new ContextTracker();
    mockGetCurrentUser.mockReturnValue('os-fallback-user');
    mockSetCurrentUser.mockClear();
    delete process.env.DOLLHOUSE_USER;
    delete process.env.DOLLHOUSE_EMAIL;
  });

  const originalUser = process.env.DOLLHOUSE_USER;
  const originalEmail = process.env.DOLLHOUSE_EMAIL;

  afterEach(() => {
    if (originalUser === undefined) delete process.env.DOLLHOUSE_USER;
    else process.env.DOLLHOUSE_USER = originalUser;
    if (originalEmail === undefined) delete process.env.DOLLHOUSE_EMAIL;
    else process.env.DOLLHOUSE_EMAIL = originalEmail;
  });

  describe('getCurrentUserForAttribution', () => {
    it('returns session userId when it is an explicit identity', async () => {
      const pm = createPersonaManager(tracker);
      const session = makeSession({ userId: 'http-user-alice' });
      const ctx = tracker.createSessionContext('llm-request', session);

      let result: string | undefined;
      await tracker.runAsync(ctx, async () => {
        result = pm.getCurrentUserForAttribution();
      });

      expect(result).toBe('http-user-alice');
    });

    it('returns session displayName over userId when both present', async () => {
      const pm = createPersonaManager(tracker);
      const session = makeSession({ userId: 'uid-123', displayName: 'Alice Smith' });
      const ctx = tracker.createSessionContext('llm-request', session);

      let result: string | undefined;
      await tracker.runAsync(ctx, async () => {
        result = pm.getCurrentUserForAttribution();
      });

      expect(result).toBe('Alice Smith');
    });

    it('falls back to MetadataService when session userId is default stdio', async () => {
      const pm = createPersonaManager(tracker);
      const session = makeSession({ userId: STDIO_DEFAULT_USER_ID });
      const ctx = tracker.createSessionContext('llm-request', session);

      let result: string | undefined;
      await tracker.runAsync(ctx, async () => {
        result = pm.getCurrentUserForAttribution();
      });

      expect(result).toBe('os-fallback-user');
    });

    it('falls back to MetadataService when session userId is system', async () => {
      const pm = createPersonaManager(tracker);
      const session = makeSession({ userId: SYSTEM_CONTEXT.userId });
      const ctx = tracker.createSessionContext('llm-request', session);

      let result: string | undefined;
      await tracker.runAsync(ctx, async () => {
        result = pm.getCurrentUserForAttribution();
      });

      expect(result).toBe('os-fallback-user');
    });

    it('falls back to MetadataService when no session is active', () => {
      const pm = createPersonaManager(tracker);
      const result = pm.getCurrentUserForAttribution();
      expect(result).toBe('os-fallback-user');
    });

    it('falls back when no contextTracker injected (backward compat)', () => {
      const pm = createPersonaManager(); // no tracker
      const result = pm.getCurrentUserForAttribution();
      expect(result).toBe('os-fallback-user');
    });
  });

  describe('getUserIdentity', () => {
    it('returns session identity for explicit session', async () => {
      const pm = createPersonaManager(tracker);
      const session = makeSession({
        userId: 'http-user-bob',
        email: 'bob@example.com',
      });
      const ctx = tracker.createSessionContext('llm-request', session);

      let result: { username: string | null; email: string | null } | undefined;
      await tracker.runAsync(ctx, async () => {
        result = pm.getUserIdentity();
      });

      expect(result?.username).toBe('http-user-bob');
      expect(result?.email).toBe('bob@example.com');
    });

    it('falls back to process.env for default stdio session', async () => {
      process.env.DOLLHOUSE_USER = 'env-user';
      process.env.DOLLHOUSE_EMAIL = 'env@example.com';

      const pm = createPersonaManager(tracker);
      const session = makeSession({ userId: STDIO_DEFAULT_USER_ID });
      const ctx = tracker.createSessionContext('llm-request', session);

      let result: { username: string | null; email: string | null } | undefined;
      await tracker.runAsync(ctx, async () => {
        result = pm.getUserIdentity();
      });

      expect(result?.username).toBe('env-user');
      expect(result?.email).toBe('env@example.com');
    });

    it('falls back to process.env when no session active', () => {
      process.env.DOLLHOUSE_USER = 'env-user';
      const pm = createPersonaManager(tracker);
      const result = pm.getUserIdentity();
      expect(result.username).toBe('env-user');
    });

    it('returns null username when no session and no env var', () => {
      const pm = createPersonaManager(tracker);
      const result = pm.getUserIdentity();
      expect(result.username).toBeNull();
      expect(result.email).toBeNull();
    });
  });
});
