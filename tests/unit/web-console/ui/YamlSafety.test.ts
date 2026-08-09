import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import yaml from 'js-yaml';

import {
  assertTextWithinByteLimit,
  parseBrowserYaml,
} from '../../../../src/web-console/ui/yaml-safety';

describe('browser YAML safety boundary', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'jsyaml', { configurable: true, value: yaml });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'jsyaml');
  });

  it('parses JSON-schema values without enabling custom YAML types', () => {
    expect(parseBrowserYaml('enabled: true\ncount: 3\n', { schema: 'json' }))
      .toEqual({ enabled: true, count: 3 });
    expect(() => parseBrowserYaml('value: !!js/function >\n  function () {}\n', { schema: 'json' }))
      .toThrow();
  });

  it('enforces UTF-8 byte limits rather than UTF-16 character counts', () => {
    expect(() => assertTextWithinByteLimit('\u{1F600}', 3)).toThrow('exceeds');
    expect(() => assertTextWithinByteLimit('\u{1F600}', 4)).not.toThrow();
  });

  it('rejects excessive alias amplification', () => {
    expect(() => parseBrowserYaml(aliasExpansionDocument(7), { schema: 'json' }))
      .toThrow(/(?:structure|content expansion) exceeds/);
  });

  it('rejects scalar aliases that exceed the expanded text budget', () => {
    const largeScalar = 'a'.repeat(10_000);
    const aliases = Array.from({ length: 10 }, () => '  - *large').join('\n');

    expect(() => parseBrowserYaml(
      `large: &large "${largeScalar}"\nreferences:\n${aliases}\n`,
      { schema: 'json' },
    )).toThrow('content expansion exceeds');
  });

  it('ignores anchor-like text inside YAML scalars and comments', () => {
    const aliasesInText = Array.from({ length: 600 }, () => '*example').join(' ');
    expect(parseBrowserYaml(
      `# &comment ${aliasesInText}\ndescription: "literal &name and ${aliasesInText}"\n`,
      { schema: 'json' },
    )).toEqual({ description: `literal &name and ${aliasesInText}` });
  });

  it('allows bounded reuse but rejects cyclic YAML output', () => {
    expect(parseBrowserYaml('value: &value\n  text: test\ncopy: *value\n', { schema: 'json' }))
      .toEqual({ value: { text: 'test' }, copy: { text: 'test' } });
    expect(() => parseBrowserYaml('cycle: &cycle\n  self: *cycle\n', { schema: 'json' }))
      .toThrow('cyclic');
  });

  it('allows non-object values only when the caller explicitly requests them', () => {
    expect(() => parseBrowserYaml('- one\n- two\n', { schema: 'json' })).toThrow('must contain an object');
    expect(parseBrowserYaml('- one\n- two\n', { schema: 'json', requireObject: false }))
      .toEqual(['one', 'two']);
  });

  it('rejects structures deeper than the console safety limit', () => {
    const deeplyNested = Array.from(
      { length: 66 },
      (_, depth) => `${'  '.repeat(depth)}level${depth}:`,
    ).join('\n') + `\n${'  '.repeat(66)}value: end\n`;

    expect(() => parseBrowserYaml(deeplyNested, { schema: 'json' }))
      .toThrow('structure exceeds');
  });
});

function aliasExpansionDocument(levels: number): string {
  const references = (name: string) => Array.from({ length: 5 }, () => `*${name}`).join(', ');
  const lines = ['level0: &level0 { value: test }'];
  for (let level = 1; level <= levels; level += 1) {
    lines.push(`level${level}: &level${level} [${references(`level${level - 1}`)}]`);
  }
  lines.push(`root: *level${levels}`);
  return `${lines.join('\n')}\n`;
}
