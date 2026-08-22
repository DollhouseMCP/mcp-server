import { describe, expect, it } from '@jest/globals';
import { SECURITY_LIMITS } from '../../../src/security/constants.js';
import { SerializationService } from '../../../src/services/SerializationService.js';

describe('frontmatter field size reserve', () => {
  it('leaves room for required metadata at the maximum description length', () => {
    const service = new SerializationService();
    const metadata = {
      name: 'n'.repeat(SECURITY_LIMITS.MAX_NAME_LENGTH),
      type: 'agent',
      unique_id: '00000000-0000-4000-8000-000000000000',
      version: '2.1.0-beta.1',
      author: 'a'.repeat(100),
      created: '2026-08-10T20:38:38.000Z',
      modified: '2026-08-10T20:38:38.000Z',
      description: 'd'.repeat(SECURITY_LIMITS.MAX_DESCRIPTION_LENGTH),
      format_version: 'v2',
      tags: Array.from({ length: 20 }, (_, index) => `tag-${index}`),
    };

    const serialized = service.createFrontmatter(metadata, '', {
      method: 'manual',
      schema: 'json',
      cleanMetadata: true,
      cleaningStrategy: 'remove-both',
      sortKeys: true,
    });
    const yamlContent = /^---\r?\n([\s\S]*?)\r?\n---/.exec(serialized)?.[1];

    expect(yamlContent).toBeDefined();
    expect(yamlContent!.length).toBeLessThanOrEqual(SECURITY_LIMITS.MAX_YAML_LENGTH);
  });
});
