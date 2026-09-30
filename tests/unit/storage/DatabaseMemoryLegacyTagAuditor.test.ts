import { jest, describe, it, expect } from '@jest/globals';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import { DatabaseMemoryLegacyTagAuditor } from '../../../src/storage/DatabaseMemoryLegacyTagAuditor.js';

const limits = { owners: 10, tags: 20, bytes: 10000, samples: 2, statementMs: 1000, wallMs: 5000 };

describe('dormant global memory tag audit boundary', () => {
  it.each(['owners', 'tags', 'bytes', 'samples', 'statementMs', 'wallMs'] as const)('rejects invalid %s before connecting', async key => {
    const transaction = jest.fn();
    const auditor = new DatabaseMemoryLegacyTagAuditor({ transaction } as unknown as DatabaseInstance);
    await expect(auditor.inspect({ ...limits, [key]: 0 })).rejects.toThrow(RangeError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('returns sanitized unknown evidence without driver errors or write authority', async () => {
    const transaction = jest.fn<DatabaseInstance['transaction']>().mockRejectedValue(new Error('private DSN and content'));
    const report = await new DatabaseMemoryLegacyTagAuditor({ transaction } as unknown as DatabaseInstance).inspect(limits);
    expect(report).toEqual({ formatVersion: 1, status: 'unknown', reason: 'query_failed', canBackfill: false, canApply: false, canActivate: false,
      counts: null, samplesTruncated: false, privateReport: { owners: [], samples: [], manifestSha256: null } });
    expect(JSON.stringify(report)).not.toContain('private DSN');
  });
});
