import { describe, it, expect, jest } from '@jest/globals';
import { ElementTransactionScope } from '../../../../src/elements/base/ElementTransactionScope.js';

describe('ElementTransactionScope', () => {
  it('executes commit actions after successful work', async () => {
    const commitOne = jest.fn();
    const commitTwo = jest.fn();
    const rollback = jest.fn();
    const work = jest.fn();

    const scope = new ElementTransactionScope('test', 'corr-123');
    scope.addCommit(commitOne);
    scope.addCommit(commitTwo);
    scope.addRollback(rollback);

    await scope.run(work);

    expect(work).toHaveBeenCalled();
    expect(commitOne).toHaveBeenCalled();
    expect(commitTwo).toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('executes rollback actions when work throws', async () => {
    const commit = jest.fn();
    const rollbackOrder: string[] = [];
    const scope = new ElementTransactionScope('test', 'corr-123');

    scope.addRollback(async () => {
      rollbackOrder.push('first');
    });
    scope.addRollback(async () => {
      rollbackOrder.push('second');
    });
    scope.addCommit(commit);

    await expect(
      scope.run(async () => {
        throw new Error('failure');
      })
    ).rejects.toThrow(/failure/);

    expect(commit).not.toHaveBeenCalled();
    expect(rollbackOrder).toEqual(['second', 'first']); // reverse order
  });
});
