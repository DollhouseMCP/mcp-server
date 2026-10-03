import { describe, expect, it, jest } from '@jest/globals';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { DatabaseMemoryReconciliationInspector, type MemoryReconciliationInspection } from '../../../src/storage/DatabaseMemoryReconciliationInspector.js';
import { SecureYamlParser } from '../../../src/security/secureYamlParser.js';
const owner = { userId: '11111111-1111-4111-8111-111111111111', memoryId: '22222222-2222-4222-8222-222222222222' };
const equivalent: MemoryReconciliationInspection = { status: 'equivalent', canApply: false, owner, name: 'Memory', revision: '1', dirty: true,
  rawUnits: 0, counts: { rawEntries: 0, childEntries: 0, volumes: 0 }, diagnostics: [], diagnosticsTruncated: false };
async function capture(rawScalar: string, databaseLexeme: string) {
  const inspector = new DatabaseMemoryReconciliationInspector({} as DatabaseInstance, () => owner.userId);
  // Isolate ONLY the extra apply eligibility step; read-only classification is
  // deliberately supplied as equivalent to demonstrate it cannot bypass guard.
  const classify = jest.spyOn(inspector, 'inspectInTransaction').mockResolvedValue(equivalent);
  const raw = `name: Memory\nentries: []\nmetadata:\n  amount: ${rawScalar}\n`;
  const value = `{"raw_content":${JSON.stringify(raw)},"metadata":{"amount":${databaseLexeme}}}`;
  let calls = 0;
  const tx = { execute: async () => ++calls === 1 ? [{ parent_bytes: Buffer.byteLength(value), tag_bytes: '0' }] : [{ kind: 'parent', value }] } as unknown as DrizzleTx;
  try { return await inspector.captureEquivalentProjection(tx, owner); }
  finally { classify.mockRestore(); }
}
describe('apply-only safe integer eligibility (actual CORE parser and original PG JSON text)', () => {
  it.each([
    ['9007199254740992', '9007199254740993'],
    ['9.00000000000000000001', '9'],
    ['0.1', '0.10000000000000000001'],
    ['1e-9999', '0'],
    ['1e2', '100'],
    ['.inf', '0'],
    ['.nan', '0'],
    ['0x20000000000001', '9007199254740993'],
    ['9', '9.0'],
    ['9', '9e0'],
    ['9007199254740993', '9007199254740992'],
  ])('refuses unqualified raw %s and DB %s without a proposal digest', async (raw, database) => {
    const result = await capture(raw, database);
    expect(result.projectionSha256).toBeNull();
    expect(result.inspection).toMatchObject({ status: 'ineligible', canApply: false,
      diagnostics: [{ code: 'unrepresentable_numeric_precision', path: 'projection' }] });
  });
  it.each([
    ['9', '9'], ['-9', '-9'], ['0x10', '16'], ['0o10', '8'], ['9007199254740991', '9007199254740991'],
    ['"9007199254740993"', '"9007199254740993"'],
    ['"9.00000000000000000001"', '"9.00000000000000000001"'],
    ['"escaped \\\"0.10000000000000000001\\\""', '"escaped \\\"0.10000000000000000001\\\""'],
  ])('retains safe values and actual quoted strings raw %s / DB %s', async (raw, database) => {
    const result = await capture(raw, database);
    expect(result.inspection).toEqual(equivalent);
    expect(result.projectionSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe('bounded secure CORE numeric facade', () => {
  it('leaves ordinary numeric parsing unchanged while explicit eligibility refuses floats', () => {
    expect(SecureYamlParser.parseRawYaml('amount: 0.1')).toEqual({ amount: 0.1 });
    expect(() => SecureYamlParser.parseRawYaml('amount: 0.1', { numericPolicy: 'safe-integers' })).toThrow('safe integer');
    try { SecureYamlParser.parseRawYaml('amount: 0.1', { numericPolicy: 'safe-integers' }); }
    catch (cause) { expect(cause).toMatchObject({ code: 'YAML_NUMERIC_PRECISION', severity: 'medium' }); }
  });
  it('retains size, unsupported-type and alias structure validation under numeric policy', () => {
    expect(() => SecureYamlParser.parseRawYaml('amount: 9', { maxSize: 4, numericPolicy: 'safe-integers' })).toThrow();
    expect(() => SecureYamlParser.parseRawYaml('value: !!js/function >\n  function() { return 1; }', { contentPolicy: 'structure-only', numericPolicy: 'safe-integers' })).toThrow();
    expect(() => SecureYamlParser.parseRawYaml(`value: &x { amount: 1 }\nitems:\n${Array.from({ length: 6 }, () => '  - *x').join('\n')}\n`, { contentPolicy: 'structure-only', numericPolicy: 'safe-integers' })).toThrow();
  });
  it('refuses the numeric policy with other schemas rather than silently treating numbers as strings', () => {
    expect(() => SecureYamlParser.parseRawYaml('amount: 0.1', { schema: 'failsafe', numericPolicy: 'safe-integers' })).toThrow('Unsupported');
  });
});
