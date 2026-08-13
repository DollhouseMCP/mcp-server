const FORMAT_CHARACTER = /\p{Cf}/u;

/** Characters that alter human-visible security text without rendering glyphs. */
export function containsUnsafeDisplayUnicode(value: string): boolean {
  return FORMAT_CHARACTER.test(value);
}
