import { PolicyUnavailableError } from './PolicyUnavailableError.js';

export interface PolicyReadFailure {
  type: string;
  reference?: string;
  reason: string;
  sessionIds?: string[];
}

/** Serializable evidence; only exact failed-reference recovery may tolerate incompleteness. */
export interface PolicyReport<T> {
  items: T[];
  failures: PolicyReadFailure[];
  complete: boolean;
}

export function requireCompletePolicyReport<T>(report: PolicyReport<T>): T[] {
  if (!report.complete) throw new PolicyUnavailableError('Policy definitions are unavailable', {
    failures: report.failures,
  });
  return report.items;
}
