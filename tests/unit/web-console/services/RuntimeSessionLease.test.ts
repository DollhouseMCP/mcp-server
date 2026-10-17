import { expect, it } from '@jest/globals';
import { InMemoryRuntimeSessionControlStore } from '../../../../src/web-console/services/runtime/InMemoryRuntimeSessionControlStore.js';
import { runtimeLeaseContract } from '../../../helpers/runtimeLeaseContract.js';
runtimeLeaseContract(async () => ({ store: new InMemoryRuntimeSessionControlStore(), userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1' }));

it('rejects invalid lease deadlines before updating the store', async () => {
  const store = new InMemoryRuntimeSessionControlStore();
  await expect(store.renewSessionLease({ sessionId: 'invalid-lease', replicaId: 'replica-a', leaseUntil: new Date(Number.NaN) })).rejects.toThrow('leaseUntil');
});
