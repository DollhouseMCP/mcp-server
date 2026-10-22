/**
 * The frontmatter subset used by DollhouseMCP, adapted from gray-matter 4.0.3.
 * Copyright (c) 2014-2018, Jon Schlinkert. MIT; see ../vendor/gray-matter-LICENSE.
 * No executable engines, filesystem API, sections, or global parse cache.
 * YAML always uses the application's direct, maintained js-yaml dependency.
 */
import { DEFAULT_SCHEMA, dump, load } from 'js-yaml';

type Engine = ((input: string) => object) | {
  parse: (input: string) => any;
  stringify?: (data: any) => string;
};
export interface FrontmatterOptions {
  language?: string;
  lang?: string;
  delimiters?: string | [string, string];
  delims?: string | [string, string];
  engines?: Record<string, Engine>;
  parsers?: Record<string, Engine>;
  excerpt?: boolean | string | ((file: FrontmatterFile, options: FrontmatterOptions) => void);
  excerpt_separator?: string;
}
export interface FrontmatterFile {
  data: Record<string, any>;
  content: string;
  excerpt: string;
  orig: Buffer | string;
  language: string;
  matter: string;
  isEmpty?: boolean;
  empty?: string;
}

function delimiters(options: FrontmatterOptions): [string, string] {
  const value = options.delims || options.delimiters || '---';
  const pair: [string, string] = typeof value === 'string' ? [value, value] : value;
  if (!pair.every(item => typeof item === 'string' && item.length > 0)) throw new Error('Invalid frontmatter delimiter');
  return pair;
}

function supportedLanguage(name: string): string {
  if (['yaml', 'yml'].includes(name.toLowerCase())) return 'yaml';
  if (name === 'json') return name;
  throw new Error('Unsupported frontmatter language');
}

function language(input: string, options: FrontmatterOptions = {}): { name: string; raw: string } {
  // Preserve gray-matter's declaration slicing (including missing-newline input).
  const opening = delimiters(options)[0];
  if (input.startsWith(opening)) input = input.slice(opening.length);
  const raw = input.slice(0, input.search(/\r?\n/));
  return { raw, name: raw.trim() };
}

function engine(name: string, options: FrontmatterOptions): Exclude<Engine, (input: string) => object> {
  const canonical = supportedLanguage(name);
  const selected = options.engines?.[name] || options.engines?.[canonical];
  if (selected) return typeof selected === 'function' ? { parse: selected } : selected;
  return canonical === 'json'
    ? { parse: JSON.parse, stringify: data => JSON.stringify(data, null, 2) }
    : { parse: source => load(source, { schema: DEFAULT_SCHEMA }), stringify: data => dump(data, { schema: DEFAULT_SCHEMA, noRefs: true }) };
}

function isEmptyMatter(source: string): boolean {
  return source.split('\n').every(line => {
    const trimmed = line.trimStart();
    // Keep the original comment rule: a bare '#' is not an empty comment,
    // and only LF ends a comment (CR remains part of its text).
    return trimmed === '' || (trimmed.startsWith('#') && trimmed.length > 1);
  });
}

function parseMatter(file: FrontmatterFile, options: FrontmatterOptions, open: string, close: string): void {
  let source = file.content.slice(open.length);
  const originalLength = source.length;
  const declaration = language(source, options);
  if (declaration.name) {
    supportedLanguage(declaration.name);
    file.language = declaration.name;
    source = source.slice(declaration.raw.length);
  }
  const closing = '\n' + close;
  const found = source.indexOf(closing);
  const end = found === -1 ? originalLength : found;
  file.matter = source.slice(0, end);
  if (isEmptyMatter(file.matter)) {
    file.isEmpty = true;
    file.empty = file.content;
  } else {
    file.data = engine(file.language, options).parse(file.matter) ?? {};
  }
  file.content = found === -1 ? '' : source.slice(end + closing.length).replace(/^\r/, '').replace(/^\n/, '');
}

function excerpt(file: FrontmatterFile, options: FrontmatterOptions, open: string): void {
  if (typeof options.excerpt === 'function') options.excerpt(file, options);
  else {
    const separator = file.data?.excerpt_separator || options.excerpt_separator;
    if (separator != null || options.excerpt) {
      const marker = typeof options.excerpt === 'string' ? options.excerpt : separator || open;
      const end = file.content.indexOf(marker);
      if (end !== -1) file.excerpt = file.content.slice(0, end);
    }
  }
}

function parse(input: string, options: FrontmatterOptions = {}): FrontmatterFile {
  const [open, close] = delimiters(options);
  supportedLanguage((options.language || options.lang || 'yaml').toLowerCase());
  if (input === '') return { data: {}, content: '', excerpt: '', orig: '', language: '', matter: '' };
  const file: FrontmatterFile = {
    data: {}, content: input.replace(/^\ufeff/, ''), excerpt: '', orig: Buffer.from(input),
    language: (options.language || options.lang || 'yaml').toLowerCase(), matter: '', isEmpty: false,
  };
  if (file.content.startsWith(open) && file.content[open.length] !== open.slice(-1)) {
    parseMatter(file, options, open, close);
  }
  excerpt(file, options, open);
  return file;
}

const newline = (value: string): string => value.endsWith('\n') ? value : value + '\n';
function stringify(content: string, data: object, options: FrontmatterOptions = {}): string {
  const file = parse(content, options);
  const selected = engine(file.language || 'yaml', options);
  if (!selected.stringify) throw new TypeError('Frontmatter engine cannot stringify');
  const serialized = selected.stringify({ ...file.data, ...data }).trim();
  const [open, close] = delimiters(options);
  let prefix = serialized === '{}' ? '' : newline(open) + newline(serialized) + newline(close);
  if (file.excerpt && !file.content.includes(file.excerpt.trim())) prefix += newline(file.excerpt) + newline(close);
  return prefix + newline(file.content);
}

export default Object.assign(parse, { stringify, language });
