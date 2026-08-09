import { describe, expect, it, jest } from '@jest/globals';

import { ElementCRUDDispatcher } from '../../../../src/handlers/mcp-aql/ElementCRUDDispatcher.js';
import type { HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';

describe('ElementCRUDDispatcher YAML import boundary', () => {
  it('rejects excessive alias amplification before invoking element creation', async () => {
    const createElement = jest.fn<HandlerRegistry['elementCRUD']['createElement']>();
    const handlers = {
      elementCRUD: { createElement },
    } as unknown as HandlerRegistry;
    const dispatcher = new ElementCRUDDispatcher(handlers);
    const aliases = Array.from({ length: 6 }, () => '  - *payload').join('\n');
    const exportPackage = {
      exportVersion: '1.0',
      exportedAt: new Date().toISOString(),
      elementType: 'skills',
      elementName: 'alias-amplification',
      format: 'yaml',
      data: `name: alias-amplification\ndescription: blocked\npayload: &payload\n  value: test\nitems:\n${aliases}\n`,
    };

    await expect(dispatcher.dispatch('import', {
      operation: 'import_element',
      params: { data: exportPackage, overwrite: true },
    })).rejects.toThrow('Malicious YAML content detected');
    expect(createElement).not.toHaveBeenCalled();
  });
});
