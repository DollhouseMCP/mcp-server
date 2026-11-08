/**
 * A fake drizzle database for DatabaseStorageLayer unit tests: it answers the layer's id scans
 * (full and incremental by updated_at), row reads by id and summary selects from an in-memory row
 * list, and logs each query. Another process's edit is a change to a row in that list.
 */
export const FAKE_DATABASE_USER = '11111111-1111-4111-8111-111111111111';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type FakeRow = { id: string; name: string; description: string; rawContent: string; updatedAt: Date };
export const skillBody = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nFollow these detailed instructions carefully.`;

type Parameters = { dates: Date[]; ids: string[] };

/** The dates and row ids a drizzle condition carries. */
function collectParameters(node: unknown, out: Parameters, seen = new Set<unknown>(), depth = 0): void {
  if (node === null || node === undefined || depth > 14) return;
  if (node instanceof Date) {
    out.dates.push(node);
    return;
  }
  if (typeof node === 'string') {
    if (UUID.test(node)) out.ids.push(node);
    return;
  }
  if (typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  const constructorName = (node as { constructor?: { name?: string } }).constructor?.name ?? '';
  if (constructorName.includes('Table') || constructorName.startsWith('Pg')) return;
  for (const value of Object.values(node)) collectParameters(value, out, seen, depth + 1);
}

/** One select's answer, by the shape of its selected fields. */
function answer(rows: FakeRow[], log: string[], fields: Record<string, unknown>, condition: unknown): unknown[] {
  const parameters: Parameters = { dates: [], ids: [] };
  collectParameters(condition, parameters);
  const keys = Object.keys(fields);
  if (keys.includes('rawContent') && keys.length === 1) {
    log.push(`readContent(${parameters.ids.join(',')})`);
    return rows.filter(row => parameters.ids.includes(row.id)).map(row => ({ rawContent: row.rawContent }));
  }
  if (keys.length === 3 && keys.includes('updatedAt')) {
    const since = parameters.dates[0];
    const selected = since ? rows.filter(row => row.updatedAt > since) : rows;
    log.push(`${since ? 'incremental' : 'full'}-scan->${selected.map(row => row.name).join(',') || '-'}`);
    return selected.map(row => ({ id: row.id, name: row.name, updatedAt: row.updatedAt }));
  }
  log.push(`select(${keys.join(',')})`);
  // A condition naming row ids (a read by id) selects those rows; one naming only the user, all of them.
  const named = rows.filter(row => parameters.ids.includes(row.id));
  return (named.length ? named : rows).map(row => ({ id: row.id, name: row.name, description: row.description, version: '1.0.0', author: 'a',
    updatedAt: row.updatedAt, byteSize: row.rawContent.length, autoLoad: false, priority: null, memoryType: null,
    userId: FAKE_DATABASE_USER, rawContent: row.rawContent, content: row.rawContent, revision: '1', storageRevision: '1',
    visibility: 'private', elementType: 'skills' }));
}

/** failContentReads: while it answers true, every select of a row's content fails as a dropped connection would. */
export function fakeDatabase(rows: FakeRow[], log: string[], options: { failContentReads?: () => boolean } = {}) {
  const query = (fields: Record<string, unknown>, condition: unknown) => {
    const result = Promise.resolve().then(() => {
      if (options.failContentReads?.() && 'rawContent' in fields) throw new Error('connection reset');
      return answer(rows, log, fields, condition);
    });
    return Object.assign(result, { limit: () => result });
  };
  const tx = {
    execute: () => Promise.resolve(undefined),
    select: (fields: Record<string, unknown>) => ({ from: () => ({ where: (condition: unknown) => query(fields, condition) }) }),
  };
  return { transaction: <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx) };
}
