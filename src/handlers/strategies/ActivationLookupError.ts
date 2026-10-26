/** A definition lookup failed; an exact saved activation can still be cleared. */
export class ActivationLookupError extends Error {
  override readonly name = 'ActivationLookupError';
}
