const NON_PRINTING_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const DEFAULT_IGNORABLE_CHARACTER = /\p{Default_Ignorable_Code_Point}/u;

/** Characters that alter human-visible security text without rendering glyphs. */
export function containsUnsafeDisplayUnicode(value: string): boolean {
  return NON_PRINTING_CHARACTER.test(value) || DEFAULT_IGNORABLE_CHARACTER.test(value);
}
