export const MAX_ENVELOPE_KEY_ID_BYTES = 255;

const PORTABLE_ENVELOPE_KEY_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Key IDs must survive env files, shell tooling, and comma-delimited key rings unchanged. */
export function isValidEnvelopeKeyId(value: string): boolean {
  return PORTABLE_ENVELOPE_KEY_ID_PATTERN.test(value)
    && Buffer.byteLength(value, 'utf8') <= MAX_ENVELOPE_KEY_ID_BYTES;
}
