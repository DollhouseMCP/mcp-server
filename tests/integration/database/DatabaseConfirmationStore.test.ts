/**
 * Integration tests for DatabaseConfirmationStore.
 * Runs against real Docker PostgreSQL.
 */

import { DatabaseConfirmationStore } from '../../../src/state/DatabaseConfirmationStore.js';
import type { ConfirmationRecord, CliApprovalRecord } from '../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import {
  getTestDb,
  ensureTestUser,
  cleanupTestSessions,
  closeTestDb,
  isDatabaseAvailable,
} from './test-db-helpers.js';

const TEST_SESSION_ID = 'testConfirmation';
let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    console.warn('Skipping DatabaseConfirmationStore tests — PostgreSQL not available');
  }
});

afterEach(async () => {
  if (dbAvailable) await cleanupTestSessions();
});

afterAll(async () => {
  await closeTestDb();
});

function makeConfirmation(operation: string): ConfirmationRecord {
  return {
    operation,
    confirmedAt: new Date().toISOString(),
    permissionLevel: 'confirm_session' as any,
    useCount: 1,
  };
}

function makeCliApproval(requestId: string): CliApprovalRecord {
  return {
    requestId,
    toolName: 'test_tool',
    toolInput: { key: 'value' },
    riskLevel: 'moderate',
    riskScore: 50,
    irreversible: false,
    requestedAt: new Date().toISOString(),
    consumed: false,
    scope: 'single' as const,
    denyReason: '',
    ttlMs: 300_000,
  };
}

describe('DatabaseConfirmationStore', () => {
  it('should initialize and create session row', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseConfirmationStore(getTestDb(), userId, TEST_SESSION_ID);

    await store.initialize();
    expect(store.getSessionId()).toBe(TEST_SESSION_ID);
  });

  it('should save and retrieve confirmations', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseConfirmationStore(getTestDb(), userId, TEST_SESSION_ID);
    await store.initialize();

    const record = makeConfirmation('create_element');
    store.saveConfirmation('create_element:skill', record);

    expect(store.getConfirmation('create_element:skill')).toEqual(record);
    expect(store.getAllConfirmations()).toHaveLength(1);
  });

  it('should save and retrieve CLI approvals', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseConfirmationStore(getTestDb(), userId, TEST_SESSION_ID);
    await store.initialize();

    const approval = makeCliApproval('cli-test-123');
    store.saveCliApproval('cli-test-123', approval);

    expect(store.getCliApproval('cli-test-123')).toEqual(approval);
    expect(store.getAllCliApprovals()).toHaveLength(1);
  });

  it('should persist and restore via await persist()', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();

    // Write and persist
    const store1 = new DatabaseConfirmationStore(getTestDb(), userId, TEST_SESSION_ID);
    await store1.initialize();
    store1.saveConfirmation('test-key', makeConfirmation('test_op'));
    await store1.persist();

    // Restore in new instance
    const store2 = new DatabaseConfirmationStore(getTestDb(), userId, TEST_SESSION_ID);
    await store2.initialize();

    expect(store2.getConfirmation('test-key')).toBeDefined();
    expect(store2.getConfirmation('test-key')!.operation).toBe('test_op');
  });

  it('should reset permissionPromptActive on initialize', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseConfirmationStore(getTestDb(), userId, TEST_SESSION_ID);
    await store.initialize();

    // permissionPromptActive is transient — should always be false on init
    expect(store.getPermissionPromptActive()).toBe(false);
  });

  it('should handle session-scoped CLI approvals', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseConfirmationStore(getTestDb(), userId, TEST_SESSION_ID);
    await store.initialize();

    const approval = makeCliApproval('cli-session-1');
    store.saveCliSessionApproval('test_tool', approval);

    expect(store.getCliSessionApproval('test_tool')).toBeDefined();
    expect(store.getAllCliSessionApprovals()).toHaveLength(1);
  });

  it('should delete confirmations', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const store = new DatabaseConfirmationStore(getTestDb(), userId, TEST_SESSION_ID);
    await store.initialize();

    store.saveConfirmation('to-delete', makeConfirmation('del_op'));
    expect(store.deleteConfirmation('to-delete')).toBe(true);
    expect(store.getConfirmation('to-delete')).toBeUndefined();
  });
});
