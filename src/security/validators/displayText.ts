const FORMAT_CHARACTER = /\p{Cf}/u;
const DEFAULT_IGNORABLE_CHARACTER = /\p{Default_Ignorable_Code_Point}/u;

/** Characters that alter human-visible security text without rendering glyphs. */
export function containsUnsafeDisplayUnicode(value: string): boolean {
  return FORMAT_CHARACTER.test(value) || DEFAULT_IGNORABLE_CHARACTER.test(value);
}
