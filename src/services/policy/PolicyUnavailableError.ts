import { ElementUnreadableError } from '../../elements/base/ElementReadError.js';
import type { ElementReadFailure } from '../../elements/base/ElementReadError.js';

/** Trim punctuation in one pass, including whitespace between terminal periods. */
function statement(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '.' || text[end - 1].trim() === '')) end--;
  return text.slice(0, end);
}

/** Policy evaluation cannot proceed without every active definition. */
export class PolicyUnavailableError extends ElementUnreadableError {
  override readonly name = 'PolicyUnavailableError';

  constructor(message: string, options?: ErrorOptions & { failures?: readonly ElementReadFailure[] }) {
    const references = options?.failures?.filter(failure => failure.type && failure.reference)
      .map(failure => `${failure.type}/${failure.reference}`) ?? [];
    super(statement(message), options);
    const recovery = references.length ? ` Deactivate that exact reference: ${references.join(', ')}.` : '';
    this.message = `${statement(this.message)}.${recovery}`;
  }
}
