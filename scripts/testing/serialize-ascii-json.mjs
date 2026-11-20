/** Serialize fixture data deterministically, escaping non-ASCII UTF-16 code units. */
export function serializeAsciiJson(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g,
    character => String.raw`\u` + character.codePointAt(0).toString(16).padStart(4, '0'));
}
