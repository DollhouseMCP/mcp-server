import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  USER_SCOPED_CASCADE_PURGE_TABLES,
  USER_SCOPED_CASCADE_PURGED_ON_DETACH,
  USER_SCOPED_CASCADE_VIA_PARENT,
} from '../../../src/database/userDataPurge.js';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../src/database/schema');

// Every `pgTable('name', ...)` whose body declares references(() => users.id, {onDelete:'cascade'}).
function cascadeOffUsersTables(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(SCHEMA_DIR).filter(f => f.endsWith('.ts') && f !== 'index.ts')) {
    const src = readFileSync(join(SCHEMA_DIR, file), 'utf8');
    const decls = [...src.matchAll(/pgTable\(\s*['"]([a-z0-9_]+)['"]/g)]
      .map(m => ({ name: m[1], index: m.index }));
    for (let i = 0; i < decls.length; i += 1) {
      const body = src.slice(decls[i].index, i + 1 < decls.length ? decls[i + 1].index : undefined);
      if (/users\.id\s*,\s*\{[^}]*onDelete:\s*['"]cascade['"]/u.test(body)) {
        found.push(decls[i].name);
      }
    }
  }
  return found;
}

describe('user-data purge coverage (schema drift guard)', () => {
  it('covers every table that cascades off users.id', () => {
    const covered = new Set([
      ...USER_SCOPED_CASCADE_PURGE_TABLES,
      ...USER_SCOPED_CASCADE_VIA_PARENT,
      ...USER_SCOPED_CASCADE_PURGED_ON_DETACH,
    ]);
    const cascadeTables = cascadeOffUsersTables();

    // Sanity: the parser actually found the cascade set (guards against a regex that silently matches nothing).
    expect(cascadeTables.length).toBeGreaterThan(10);

    const uncovered = [...new Set(cascadeTables)].filter(t => !covered.has(t)).sort((a, b) => a.localeCompare(b));
    // If this fails, a new user-owned table was added that cascades off users.id but is not
    // erased on account deletion — add it to purgeUserScopedData (or the via-parent list).
    expect(uncovered).toEqual([]);
  });

  it('does not list purge tables that are not actually user-owned cascade tables', () => {
    const cascadeTables = new Set(cascadeOffUsersTables());
    const stale = USER_SCOPED_CASCADE_PURGE_TABLES.filter(t => !cascadeTables.has(t));
    expect(stale).toEqual([]);
  });
});
