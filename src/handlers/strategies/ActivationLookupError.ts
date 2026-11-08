import { ElementUnreadableError } from '../../elements/base/ElementReadError.js';

/** A definition lookup failed; an exact saved activation can still be cleared. */
export class ActivationLookupError extends ElementUnreadableError {
  override readonly name = 'ActivationLookupError';
}
