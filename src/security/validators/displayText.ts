/**
 * Characters that can make human-visible security text render differently
 * from its stored value without contributing visible content.
 */
export function containsUnsafeDisplayUnicode(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      codePoint === 0x2060 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}
