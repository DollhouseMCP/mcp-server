import { describe, expect, it } from '@jest/globals';
import matter from '../../../src/security/frontmatter.js';

describe('frontmatter supported subset', () => {
  it.each([
    ['# Markdown\r\nBody', {}, '# Markdown\r\nBody'],
    ['----\nname: untouched', {}, '----\nname: untouched'],
    ['\ufeff---\r\nname: Test\r\n---\r\n\r\nBody\r\n', { name: 'Test' }, '\r\nBody\r\n'],
    ['---\n# comment\n---\nBody', {}, 'Body'],
    ['---\nname: Test', { name: 'Test' }, ''],
    ['---\nname: Test\n---\n\nBody\n', { name: 'Test' }, '\nBody\n'],
    ['---json\n{"count":2}\n---\nBody', { count: 2 }, 'Body'],
  ])('preserves boundary/content behavior for %j', (input, data, body) => {
    const result = matter(input as string);
    expect(result.data).toEqual(data);
    expect(result.content).toBe(body);
  });

  it('handles custom delimiters, language aliases and excerpts', () => {
    const parsed = matter('~~~YML\nname: Test\nEND\nLead\n<!--more-->\nRest', {
      delims: ['~~~', 'END'], excerpt_separator: '<!--more-->',
    });
    expect(parsed.data).toEqual({ name: 'Test' });
    expect(parsed.excerpt).toBe('Lead\n');
  });

  it('detects language declarations using the configured opening delimiter', () => {
    expect(matter.language('~~~json\n{}', { delimiters: '~~~' })).toEqual({ raw: 'json', name: 'json' });
    expect(matter.language('<!--YML\r\nname: Test', { delims: ['<!--', '-->'] }))
      .toEqual({ raw: 'YML', name: 'YML' });
    expect(matter.language('---yaml\nname: Test', { delimiters: '~~~' }))
      .toEqual({ raw: '---yaml', name: '---yaml' });
    expect(matter.language('---json\n{}')).toEqual({ raw: 'json', name: 'json' });
    expect(matter.language('~~~json', { delimiters: '~~~' })).toEqual({ raw: 'jso', name: 'jso' });
  });

  it.each([
    ['\n# comment\n', true],
    ['\r\n  # comment\r\n\r\n', true],
    ['\n# comment\rname: still comment\r\n', true],
    ['\n#\n', false],
    ['\n#\r\n', true],
    ['\n# \n', true],
    ['\n  \t\r\n', true],
    ['\n# comment\nname: Test\n', false],
  ])('preserves empty/comment classification for %j', (source, isEmpty) => {
    const parsed = matter(`---${source}---\nBody`);
    expect(parsed.isEmpty).toBe(isEmpty);
    expect(parsed.empty).toBe(isEmpty ? `---${source}---\nBody` : undefined);
  });

  it('handles a long whitespace-only frontmatter line', () => {
    const parsed = matter(`---\n${' '.repeat(100_000)}\n---\nBody`);
    expect(parsed.isEmpty).toBe(true);
    expect(parsed.content).toBe('Body');
  });

  it('rejects malformed YAML and executable language declarations', () => {
    expect(() => matter('---\nname: [broken\n---\nBody')).toThrow();
    expect(() => matter('---javascript\nprocess.exit()\n---\nBody')).toThrow('Unsupported frontmatter language');
    expect(() => matter('---\nname: !!js/function function() {}\n---\nBody')).toThrow();
    expect(() => matter('Body', { language: 'js' })).toThrow('Unsupported frontmatter language');
  });

  it('retains default safe YAML timestamps and array roots for generic callers', () => {
    expect(matter('---\ncreated: 2026-09-01\n---\nBody').data.created).toEqual(new Date('2026-09-01'));
    expect(matter('---\n- one\n- two\n---\nBody').data).toEqual(['one', 'two']);
  });

  it('unwraps existing frontmatter, merges metadata, and preserves body newline rules', () => {
    expect(matter.stringify('---\nold: retained\nname: Before\n---\n\nBody', { name: 'After' }))
      .toBe('---\nold: retained\nname: After\n---\n\nBody\n');
    expect(matter.stringify('Body', {})).toBe('Body\n');
    expect(matter.stringify('', { enabled: true })).toBe('---\nenabled: true\n---\n\n');
    expect(matter(matter.stringify('Body\n', { nested: { list: ['one', true, 4] } })).data)
      .toEqual({ nested: { list: ['one', true, 4] } });
  });
});
