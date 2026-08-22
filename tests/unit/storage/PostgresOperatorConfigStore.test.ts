import { describe, expect, it, jest } from '@jest/globals';

import type { DrizzleTx } from '../../../src/database/db-utils.js';
import {
  saveOperatorConfigWithTx,
} from '../../../src/storage/operatorConfig/PostgresOperatorConfigStore.js';

describe('PostgresOperatorConfigStore initial compare-and-swap', () => {
  it('materializes the default singleton before locking an initial CAS update', async () => {
    const materialize = jest.fn(async () => undefined);
    const update = jest.fn(async () => undefined);
    const materializeValues = jest.fn<(row: Record<string, unknown>) => {
      onConflictDoNothing: typeof materialize;
    }>(() => ({ onConflictDoNothing: materialize }));
    const updateValues = jest.fn<(row: Record<string, unknown>) => {
      onConflictDoUpdate: typeof update;
    }>(() => ({ onConflictDoUpdate: update }));
    let insertCount = 0;
    const insert = jest.fn(() => {
      insertCount += 1;
      return { values: insertCount === 1 ? materializeValues : updateValues };
    });
    const lockedRows = [{ updatedAt: new Date(0) }];
    const selectChain = {
      from: jest.fn(),
      where: jest.fn(),
      for: jest.fn<(mode: string) => Promise<typeof lockedRows>>(async () => lockedRows),
    };
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);
    const select = jest.fn(() => selectChain);
    const tx = { insert, select } as unknown as DrizzleTx;

    await saveOperatorConfigWithTx(tx, {
      enhancedIndexConfig: {},
      consoleConfig: { port: 41716 },
      licenseConfig: {},
      defaultsConfig: {},
      configVersion: 1,
    }, { expectedUpdatedAt: 0 });

    expect(insert).toHaveBeenCalledTimes(2);
    expect(materializeValues).toHaveBeenCalledWith(expect.objectContaining({
      id: 1,
      updatedAt: new Date(0),
    }));
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.invocationCallOrder[0])
      .toBeLessThan(select.mock.invocationCallOrder[0]);
    expect(selectChain.for).toHaveBeenCalledWith('update');
    expect(updateValues).toHaveBeenCalledWith(expect.objectContaining({
      consoleConfig: { port: 41716 },
    }));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('locks the singleton before an unconditional write assigns its revision token', async () => {
    const materialize = jest.fn(async () => undefined);
    const update = jest.fn(async () => undefined);
    const materializeValues = jest.fn(() => ({ onConflictDoNothing: materialize }));
    const updateValues = jest.fn(() => ({ onConflictDoUpdate: update }));
    let insertCount = 0;
    const insert = jest.fn(() => ({
      values: insertCount++ === 0 ? materializeValues : updateValues,
    }));
    const lockedRows = [{ updatedAt: new Date(41) }];
    const selectChain = {
      from: jest.fn(),
      where: jest.fn(),
      for: jest.fn(async () => lockedRows),
    };
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);
    const select = jest.fn(() => selectChain);
    const tx = { insert, select } as unknown as DrizzleTx;
    jest.spyOn(Date, 'now').mockReturnValue(41);

    await saveOperatorConfigWithTx(tx, {
      enhancedIndexConfig: {},
      consoleConfig: { port: 41716 },
      licenseConfig: {},
      defaultsConfig: {},
      configVersion: 1,
    });

    expect(materialize.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[0]);
    expect(selectChain.for).toHaveBeenCalledWith('update');
    expect(updateValues).toHaveBeenCalledWith(expect.objectContaining({ updatedAt: new Date(42) }));
  });
});
