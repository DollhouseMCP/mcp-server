const NON_PRINTING_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const DEFAULT_IGNORABLE_CHARACTER = /\p{Default_Ignorable_Code_Point}/u;

/** Characters that alter human-visible security text without rendering glyphs. */
export function containsUnsafeDisplayUnicode(value: string): boolean {
  return NON_PRINTING_CHARACTER.test(value) || DEFAULT_IGNORABLE_CHARACTER.test(value);
}

/** Bound a review preview and make invisible characters visible without splitting escapes. */
export function formatDisplayPreview(text: string, maximumLength: number, preserveNewlines = false): string {
  let preview = '';
  for (const character of text) {
    const keepNewline = preserveNewlines && character === '\n';
    const visible = !keepNewline && containsUnsafeDisplayUnicode(character)
      ? String.raw`\u{${character.codePointAt(0)!.toString(16)}}`
      : character;
    if (preview.length + visible.length >= maximumLength) return `${preview}…`;
    preview += visible;
  }
  return preview;
}
