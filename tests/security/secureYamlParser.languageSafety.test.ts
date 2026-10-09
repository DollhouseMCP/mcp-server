import { afterEach, describe, expect, it } from '@jest/globals';
import type matter from 'gray-matter';
import { SecureYamlParser } from '../../src/security/secureYamlParser.js';

type Options = matter.GrayMatterOption<string, any> & { lang?: string; delims?: string | [string, string]; parsers?: Record<string, (input: string) => object> };
const marker = '__dollhouseMatterReadNonexecutionTest';
const state = globalThis as typeof globalThis & { [marker]?: boolean };
const expression = `(globalThis.${marker} = true, { name: 'Ordinary' })`;
afterEach(() => { delete state[marker]; });

function refusesWithoutExecuting(input: string, options?: Options): void {
  let failure: unknown;
  try { SecureYamlParser.safeMatter(input, options); } catch (error) { failure = error; }
  expect(state[marker]).toBeUndefined();
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/Unsupported frontmatter language/);
}

describe('safeMatter nonexecuting language selection', () => {
  it.each(['javascript', 'js', 'JAVASCRIPT', 'bom'])('refuses body language %s before execution', language => {
    const opening = language === 'bom' ? '\ufeff---javascript' : `---${language}`;
    refusesWithoutExecuting(`${opening}\n${expression}\n---\nBody`);
  });

  it.each([{ language: 'javascript' }, { lang: 'JS' }])('refuses option-selected language %j', options => {
    refusesWithoutExecuting(`---\n${expression}\n---\nBody`, options);
  });

  it.each<Options>([{ delimiters: '~~~' }, { delimiters: ['~~~', 'END'] }, { delims: '~~~' }])('refuses executable selection with custom delimiters %j', options => {
    const closing = Array.isArray(options.delimiters) ? 'END' : '~~~';
    refusesWithoutExecuting(`~~~javascript\n${expression}\n${closing}\nBody`, options);
  });

  it.each(['yaml', 'YML'])('retains safe %s body handling with custom delimiters', language => {
    const result = SecureYamlParser.safeMatter(`~~~${language}\nname: Ordinary\nenabled: true\n~~~\nBody`, { delimiters: '~~~' });
    expect(result.data).toEqual({ name: 'Ordinary', enabled: true });
    expect(result.content).toBe('Body');
  });

  it('retains JSON body handling and normalized option-selected JSON', () => {
    const declared = SecureYamlParser.safeMatter('---json\n{"name":"Ordinary"}\n---\nBody');
    const configured = SecureYamlParser.safeMatter('~~~\n{"name":"Ordinary"}\nEND\nBody', { language: 'JSON', delimiters: ['~~~', 'END'] });
    expect(declared.data).toEqual({ name: 'Ordinary' });
    expect(configured.data).toEqual({ name: 'Ordinary' });
    expect(configured.content).toBe('Body');
  });

  it('uses its own YAML parser even when an alias parser is supplied in options', () => {
    const result = SecureYamlParser.safeMatter('---YAML\nname: Ordinary\n---\nBody', { parsers: { YAML: () => { state[marker] = true; return {}; } } } as Options);
    expect(state[marker]).toBeUndefined();
    expect(result.data).toEqual({ name: 'Ordinary' });
  });

  it('preserves plain Markdown and repeated delimiter prefixes as content', () => {
    const input = '----javascript\nReference text';
    expect(SecureYamlParser.safeMatter(input).content).toBe(input);
    expect(SecureYamlParser.safeMatter('# Markdown').data).toEqual({});
  });
});
