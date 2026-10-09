import { describe, expect, it } from '@jest/globals';
import { DatabaseMemoryBootQualification } from '../../../src/storage/DatabaseMemoryBootQualification.js';

const identity = () => ({ tenant: 'captured-tenant', store: {}, backend: 'database' as const });
describe('fresh process qualification is closed and cannot restore captured authority', () => {
  it('starts closed, requires exact store/tenant, and rejects a structural copy', async () => {
    const boot = new DatabaseMemoryBootQualification(); const owner = identity();
    expect(() => boot.capture(owner)).toThrow('Fresh guarded');
    await boot.qualify(owner, async () => {}); const captured = boot.capture(owner);
    boot.require(captured, owner);
    expect(() => boot.capture({ ...owner, tenant: 'other' })).toThrow('Fresh guarded');
    expect(() => boot.capture({ ...owner, store: {} })).toThrow('Fresh guarded');
    expect(() => boot.require({ ...captured }, owner)).toThrow('Fresh guarded');
    expect(() => new DatabaseMemoryBootQualification().require(captured, owner)).toThrow('Fresh guarded');
  });
  it('closes previously captured and in-progress qualification, then requires a fresh inspection', async () => {
    const boot = new DatabaseMemoryBootQualification(); const owner = identity();
    await boot.qualify(owner, async () => {}); const captured = boot.capture(owner);
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const pending = boot.qualify(owner, () => barrier); const result = pending.then(() => undefined, cause => cause);
    boot.close(); release(); expect(await result).toMatchObject({ code: 'EMEMORYBOOT' });
    expect(() => boot.require(captured, owner)).toThrow('Fresh guarded');
    await boot.qualify(owner, async () => {}); expect(boot.capture(owner)).not.toBe(captured);
  });
  it('preserves failed qualification cause and never opens from the failed check', async () => {
    const boot = new DatabaseMemoryBootQualification(); const owner = identity(); const original = new Error('qualification refused');
    await expect(boot.qualify(owner, async () => { throw original; })).rejects.toBe(original);
    expect(() => boot.capture(owner)).toThrow('Fresh guarded');
  });
});
