import { ElementIndeterminateError, type ElementReadError } from './ElementReadError.js';
import { couldHoldElementName } from './ElementNameEvidence.js';

export interface CollectionFailure {
  readonly reference?: string;
  readonly elementName?: string;
  readonly candidateNames?: readonly string[];
  /** The storage layer's verdict that this failed record may stand in for a listed name (UnindexedEntry). */
  readonly shadowsSurvivors?: boolean;
  readonly error: ElementReadError;
}

/** Per-operation evidence; failures are not historical loader diagnostics. */
export interface CollectionReport<T> {
  readonly items: T[];
  readonly failures: CollectionFailure[];
  readonly complete: boolean;
}

/** Client-facing diagnostics deliberately omit Error instances and causes. */
export function collectionReportEvidence(report: CollectionReport<unknown>) {
  return { complete: report.complete,
    failures: report.failures.map(failure => ({ reference: failure.reference, name: failure.elementName, reason: failure.error.message })) };
}

export function collectionReportNotice(report: CollectionReport<unknown>): string {
  if (report.complete) return '';
  const failures = report.failures.map(failure => `${failure.reference ?? 'collection'}: ${failure.error.message}`);
  return `Listing incomplete: ${report.items.length} readable, ${failures.length} unreadable. Unattributed failures may affect any listed name.\n${failures.join('\n')}`;
}

/**
 * Display survivors without presenting another copy of a failed name as current. Which failed
 * records can be such a copy is the storage layer's naming rule (shadowsSurvivors): element files
 * only through a parsed name, memories under the newest-owner rule through any copy.
 */
export function collectionSurvivors<T>(report: CollectionReport<T>, nameOf: (item: T) => string): T[] {
  return report.items.filter(item => !report.failures.some(failure => failure.reference !== undefined && failure.shadowsSurvivors !== false
    && couldHoldElementName(failure.reference, failure.candidateNames ?? (failure.elementName ? [failure.elementName] : []), nameOf(item))));
}

export function requireCompleteCollection<T>(report: CollectionReport<T>): T[] {
  if (!report.complete) {
    throw new ElementIndeterminateError('Element collection could not be read completely', {
      failures: report.failures.map(failure => ({ reference: failure.reference, reason: failure.error.message })),
      cause: new AggregateError(report.failures.map(failure => failure.error), 'Element collection failures'),
    });
  }
  return report.items;
}
