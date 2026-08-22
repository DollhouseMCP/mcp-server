import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import { consoleSessions } from '../../../src/database/schema/index.js';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/database/migrations/0056_console_session_authz_generation.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8').replaceAll('\r\n', '\n');

describe('console session authorization generation migration', () => {
  it('adds a durable non-null generation to browser sessions', () => {
    expect(consoleSessions.authzVersion).toBeDefined();
    expect(migrationSql).toContain('ADD COLUMN "authz_version" integer DEFAULT 0 NOT NULL');
  });
});
