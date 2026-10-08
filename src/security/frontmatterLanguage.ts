import matter from 'gray-matter';

/** gray-matter also recognizes the legacy lang/delims option aliases at runtime. */
type LanguageOptions = matter.GrayMatterOption<string, any> & {
  lang?: string;
  delims?: string | [string, string];
};

function assertLanguage(language: string): void {
  // Body declarations use exact engine names; only YAML has case-insensitive aliases.
  if (language && !['yaml', 'yml'].includes(language.toLowerCase()) && language !== 'json') {
    throw new Error('Unsupported frontmatter language');
  }
}

/** Admit engine selection before gray-matter can parse a body, including custom delimiters. */
export function assertSupportedFrontmatterLanguage(input: string, options: LanguageOptions = {}): void {
  // defaults() normalizes option-selected languages, but not body declarations.
  assertLanguage((options.language || options.lang || 'yaml').toLowerCase());
  const delimiters = options.delims || options.delimiters || '---';
  const opening = Array.isArray(delimiters) ? delimiters[0] : delimiters;
  if (typeof opening !== 'string' || opening.length === 0) throw new Error('Invalid frontmatter delimiter');
  // Match toFile()'s single leading BOM removal and parseMatter()'s repeated-prefix rule.
  const content = input.startsWith('\ufeff') ? input.slice(1) : input;
  if (!content.startsWith(opening) || content[opening.length] === opening.slice(-1)) return;
  assertLanguage(matter.language(content.slice(opening.length), options).name);
}
