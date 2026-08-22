import { describe, expect, it } from '@jest/globals';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { getTableName, is } from 'drizzle-orm';

import * as schema from '../../../src/database/schema/index.js';
import { users } from '../../../src/database/schema/index.js';
import {
  USER_SCOPED_CASCADE_PURGE_TABLES,
  USER_SCOPED_CASCADE_PURGED_ON_DETACH,
  USER_SCOPED_CASCADE_VIA_PARENT,
} from '../../../src/database/userDataPurge.js';

// Read the compiled FK metadata straight from Drizzle rather than parsing source — immune to
// formatting/quoting and reflects exactly what the DB will enforce.
function allTableConfigs() {
  const configs: ReturnType<typeof getTableConfig>[] = [];
  for (const value of Object.values(schema)) {
    // Skip non-table exports (types, enum consts, helpers) via Drizzle's runtime guard.
    if (is(value, PgTable)) configs.push(getTableConfig(value));
  }
  return configs;
}

function cascadeOffUsersTables(): Set<string> {
  const usersName = getTableName(users);
  const found = new Set<string>();
  for (const cfg of allTableConfigs()) {
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      let foreignTable = '';
      try {
        foreignTable = getTableName(ref.foreignTable);
      } catch {
        continue;
      }
      const referencesUserId = ref.foreignColumns.some((c: { readonly name: string }) => c.name === 'id');
      if (foreignTable === usersName && referencesUserId && fk.onDelete === 'cascade') {
        found.add(cfg.name);
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
    const cascade = cascadeOffUsersTables();

    // Sanity: introspection actually found the real cascade set.
    expect(cascade.size).toBeGreaterThan(10);
    expect(cascade.has('elements')).toBe(true);

    // If this fails, a new user-owned table cascades off users.id but is not erased on account
    // deletion — add it to purgeUserScopedData (or the via-parent / detach list).
    const uncovered = [...cascade].filter(t => !covered.has(t)).sort((a, b) => a.localeCompare(b));
    expect(uncovered).toEqual([]);
  });

  it('lists no purge / via-parent / detach table that no longer exists in the schema', () => {
    const allTables = new Set(allTableConfigs().map(c => c.name));
    const listed = [
      ...USER_SCOPED_CASCADE_PURGE_TABLES,
      ...USER_SCOPED_CASCADE_VIA_PARENT,
      ...USER_SCOPED_CASCADE_PURGED_ON_DETACH,
    ];
    const stale = listed.filter(t => !allTables.has(t)).sort((a, b) => a.localeCompare(b));
    expect(stale).toEqual([]);
  });
});
