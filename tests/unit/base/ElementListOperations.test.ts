import { describe, expect, it, jest } from '@jest/globals';
import { ElementListOperations } from '../../../src/elements/base/ElementListOperations.js';

describe('ElementListOperations.scanAndEvict', () => {
  it('uses database identifiers directly when evicting writable-storage cache entries', async () => {
    const cache = { uncacheByPath: jest.fn() };
    const storageLayer = {
      invalidate: jest.fn(),
      scan: jest.fn().mockResolvedValue({
        added: [],
        modified: ['modified-uuid'],
        removed: ['removed-uuid'],
        unchanged: [],
      }),
      writeContent: jest.fn(),
      deleteContent: jest.fn(),
      readContent: jest.fn(),
    };
    const operations = new ElementListOperations(
      { elementDir: '/portfolio/skills' } as any,
      cache as any,
      {} as any,
      {} as any,
      storageLayer as any,
      undefined,
      undefined,
    );

    await operations.scanAndEvict({ freshAfterInFlight: true });

    expect(storageLayer.invalidate).toHaveBeenCalledTimes(1);
    expect(storageLayer.scan).toHaveBeenCalledWith({ freshAfterInFlight: true });
    expect(cache.uncacheByPath.mock.calls).toEqual([
      ['modified-uuid'],
      ['removed-uuid'],
    ]);
  });
});
