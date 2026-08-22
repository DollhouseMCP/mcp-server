import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import { agentReplacementJournals } from '../../../src/database/schema/index.js';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/database/migrations/0053_agent_replacement_journal.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8').replaceAll('\r\n', '\n');

describe('agent replacement journal migration', () => {
  it('permits only one active replacement per user and agent across sessions', () => {
    expect(migrationSql).toContain(
      'ON "agent_replacement_journals" ("user_id", "agent_id")',
    );
    expect(migrationSql).toContain('WHERE "quarantined_at" IS NULL');
    expect(migrationSql).not.toContain(
      'ON "agent_replacement_journals" ("user_id", "session_id", "agent_id")',
    );
  });

  it('retains quarantined records outside the active uniqueness fence', () => {
    expect(agentReplacementJournals.quarantinedAt).toBeDefined();
    expect(agentReplacementJournals.quarantineReason).toBeDefined();
    expect(migrationSql).toContain('"quarantined_at" TIMESTAMPTZ');
    expect(migrationSql).toContain('"quarantine_reason" TEXT');
  });

  it('persists process incarnation for PID-reuse-safe ownership checks', () => {
    expect(agentReplacementJournals.ownerProcessIncarnation).toBeDefined();
    expect(migrationSql).toContain('"owner_process_incarnation" JSONB');
  });
});
