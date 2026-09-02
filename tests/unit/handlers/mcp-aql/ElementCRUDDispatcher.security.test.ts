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
    const exportPackage = {
      exportVersion: '1.0',
      exportedAt: new Date().toISOString(),
      elementType: 'skills',
      elementName: 'alias-amplification',
      format: 'yaml',
      data: `name: alias-amplification\ndescription: blocked\n${aliasExpansionDocument(8)}`,
    };

    await expect(dispatcher.dispatch('import', {
      operation: 'import_element',
      params: { data: exportPackage, overwrite: true },
    })).rejects.toThrow(/YAML (aliases|structure)/);
    expect(createElement).not.toHaveBeenCalled();
  });

  it('preserves legitimate code-like scalar text in YAML imports', async () => {
    const createElement = jest.fn<HandlerRegistry['elementCRUD']['createElement']>()
      .mockResolvedValue({ success: true });
    const handlers = {
      elementCRUD: {
        createElement,
        getElementDetails: jest.fn().mockRejectedValue(new Error('not found')),
      },
    } as unknown as HandlerRegistry;
    const dispatcher = new ElementCRUDDispatcher(handlers);
    const content = "Explain require('./module'), eval(example), and file:// references.";

    await expect(dispatcher.dispatch('import', {
      operation: 'import_element',
      params: {
        overwrite: true,
        data: {
          exportVersion: '1.0',
          elementType: 'skills',
          format: 'yaml',
          data: `name: code-guide\ndescription: Code guide\ncontent: ${JSON.stringify(content)}\n`,
        },
      },
    })).resolves.toEqual({ success: true });

    expect(createElement).toHaveBeenCalledWith(expect.objectContaining({ content }));
  });
});

function aliasExpansionDocument(levels: number): string {
  const references = (name: string) => Array.from({ length: 5 }, () => `*${name}`).join(', ');
  const lines = ['level0: &level0 { value: test }'];
  for (let level = 1; level <= levels; level += 1) {
    const referencedLevel = `level${level - 1}`;
    lines.push(`level${level}: &level${level} [${references(referencedLevel)}]`);
  }
  lines.push(`root: *level${levels}`);
  return `${lines.join('\n')}\n`;
}
