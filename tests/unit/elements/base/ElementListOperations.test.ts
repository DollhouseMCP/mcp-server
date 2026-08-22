import { describe, expect, it, jest } from '@jest/globals';
import { ElementListOperations } from '../../../../src/elements/base/ElementListOperations.js';
import type { ElementCache } from '../../../../src/elements/base/ElementCache.js';
import type { IElement } from '../../../../src/types/elements/IElement.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import type { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import type { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import type { IWritableStorageLayer } from '../../../../src/storage/IStorageLayer.js';

describe('ElementListOperations database failures', () => {
  it('surfaces a database scan failure instead of reporting an empty portfolio', async () => {
    const failure = new Error('database unavailable');
    const storage = {
      scan: jest.fn(() => Promise.reject(failure)),
      writeContent: jest.fn(),
    } as unknown as IWritableStorageLayer;
    const operations = new ElementListOperations<IElement>(
      {
        elementType: ElementType.SKILL,
        elementDir: '/unused',
        parseContent: () => ({ data: {}, content: '' }),
        migrateMetadataDefaults: () => undefined,
        parseMetadata: () => Promise.reject(new Error('unused')),
        createElement: () => { throw new Error('unused'); },
        load: () => Promise.reject(new Error('unused')),
        resolveAbsolutePath: value => value,
        getElementLabelCapitalized: () => 'Skill',
        constructor: { name: 'TestManager' },
      },
      {} as ElementCache<IElement>,
      {} as PortfolioManager,
      {} as FileOperationsService,
      storage,
      undefined,
      undefined,
    );

    await expect(operations.list()).rejects.toBe(failure);
  });
});
