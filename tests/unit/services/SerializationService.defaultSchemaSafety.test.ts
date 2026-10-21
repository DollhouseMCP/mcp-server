import { describe, expect, it } from '@jest/globals';
import { SerializationService } from '../../../src/services/SerializationService.js';

describe('supported DEFAULT YAML schema', () => {
  const service = new SerializationService();

  it('preserves scalar types, timestamps and ordinary merge precedence', () => {
    const parsed = service.parsePureYaml([
      'created: 2020-01-01',
      'base: &base {enabled: true, count: 42}',
      'selected: {<<: *base, count: 2}',
    ].join('\n'), { schema: 'default' });
    expect(parsed.created).toStrictEqual(new Date('2020-01-01T00:00:00.000Z'));
    expect(parsed.base).toStrictEqual({ enabled: true, count: 42 });
    expect(parsed.selected).toStrictEqual({ enabled: true, count: 2 });
  });

  it('preserves ordered maps through the public pure-YAML frontmatter path', () => {
    const parsed = service.parseFrontmatter('ordered: !!omap\n  - first: 1\n  - second: 2\n', {
      schema: 'default',
    });
    expect(parsed.data.ordered).toStrictEqual([{ first: 1 }, { second: 2 }]);
  });

  it('charges each empty merge source before processing beyond the library budget', () => {
    // Distinct inline empty mappings, without alias reuse or an oversized
    // sequence: each 100-source sequence is valid, but their aggregate exceeds
    // the parser's 10,000-work budget within the existing input-size limit.
    const sources = Array(100).fill('{}').join(',');
    const source = Array.from({ length: 101 }, (_, index) =>
      `selected${index}: {<<: [${sources}]}`).join('\n');
    expect(source.length).toBeLessThan(64 * 1024);
    expect(() => service.parsePureYaml(source, { schema: 'default' }))
      .toThrow(/maxTotalMergeKeys/);
  });

  it('refuses collection nesting beyond the parser depth budget', () => {
    const source = `nested: ${'['.repeat(101)}0${']'.repeat(101)}`;
    expect(() => service.parsePureYaml(source, { schema: 'default' })).toThrow(/maxDepth/);
  });
});
