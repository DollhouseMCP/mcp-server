import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { SearchHandler } from '../../../../src/handlers/mcp-aql/SearchHandler.js';
import type { HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createElementQueryService } from '../../../../src/services/query/ElementQueryService.js';
import { ElementUnreadableError } from '../../../../src/elements/base/ElementReadError.js';
import { applyFieldSelection } from '../../../../src/handlers/mcp-aql/FieldSelection.js';

afterEach(() => jest.restoreAllMocks());

describe('search failure disclosure', () => {
  it.each(['Memory caller namespace binding mismatch', 'Memory operation context changed'])(
    'propagates %s instead of reporting a partial search', async message => {
      const failure = new Error(message);
      const getElements = jest.fn<() => Promise<never>>().mockRejectedValue(failure);
      const handler = new SearchHandler({ elementCRUD: { getElements } } as unknown as HandlerRegistry);
      await expect(handler.dispatch('search', { operation: 'search_elements',
        params: { query: 'healthy' } } as any)).rejects.toBe(failure);
      expect(getElements).toHaveBeenCalledTimes(1);
    });
  it.each(['query', 'search'] as const)('keeps readable %s results and reports the unreadable reference', async method => {
    const getElements = jest.fn(async () => ({
      items: [{ metadata: { name: 'healthy-template', description: 'Readable template' } }],
      failures: [{ reference: 'broken.md', error: new ElementUnreadableError('Invalid YAML') }], complete: false,
    }));
    const handler = new SearchHandler({ elementCRUD: { getElements }, elementQueryService: createElementQueryService() } as unknown as HandlerRegistry);
    const result = await handler.dispatch(method, { operation: 'search_elements', elementType: 'templates',
      params: { element_type: 'templates', query: 'healthy' } } as any);
    const filtered = applyFieldSelection(result, { fields: 'minimal' });
    expect(filtered).toMatchObject({ complete: false, items: [expect.objectContaining({ element_name: 'healthy-template' })],
      failures: [expect.objectContaining({ reason: 'Invalid YAML', reference: expect.stringContaining('broken.md') })] });
  });
});
