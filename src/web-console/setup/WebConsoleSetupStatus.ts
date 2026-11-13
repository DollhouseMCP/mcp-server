import {
  WEB_CONSOLE_SETUP_CHECKS,
  WEB_CONSOLE_SETUP_CHECK_IDS,
  isWebConsoleSetupCheckId,
  type WebConsoleSetupCheckDefinition,
  type WebConsoleSetupCheckId,
} from './WebConsoleSetupChecks.js';

/**
 * - `passed`: the system verified it.
 * - `pending`: not verified yet; nothing is known to be wrong.
 * - `failed`: the system looked and found a problem.
 * - `not_applicable`: the feature is switched off in this deployment.
 */
export type WebConsoleSetupCheckState = 'passed' | 'pending' | 'failed' | 'not_applicable';

export interface WebConsoleSetupCheckResult {
  readonly id: WebConsoleSetupCheckId;
  readonly state: WebConsoleSetupCheckState;
  readonly detail?: string;
}

export interface WebConsoleSetupCheckStatus {
  readonly definition: WebConsoleSetupCheckDefinition;
  readonly state: WebConsoleSetupCheckState;
  readonly detail?: string;
}

/**
 * Every check in catalog order, each with its definition. A check with no
 * result is pending: nothing has reported on it yet.
 */
export function listWebConsoleSetupCheckStatuses(
  results: readonly WebConsoleSetupCheckResult[],
): readonly WebConsoleSetupCheckStatus[] {
  const byId = indexResults(results);
  return WEB_CONSOLE_SETUP_CHECK_IDS.map((id): WebConsoleSetupCheckStatus => {
    const result = byId.get(id);
    return {
      definition: WEB_CONSOLE_SETUP_CHECKS[id],
      state: result?.state ?? 'pending',
      ...(result?.detail === undefined ? {} : { detail: result.detail }),
    };
  });
}

function indexResults(
  results: readonly WebConsoleSetupCheckResult[],
): ReadonlyMap<WebConsoleSetupCheckId, WebConsoleSetupCheckResult> {
  const byId = new Map<WebConsoleSetupCheckId, WebConsoleSetupCheckResult>();
  for (const result of results) {
    if (!isWebConsoleSetupCheckId(result.id)) {
      throw new Error(`Unknown web console setup check: ${String(result.id)}`);
    }
    if (byId.has(result.id)) {
      throw new Error(`Duplicate result for web console setup check: ${result.id}`);
    }
    byId.set(result.id, result);
  }
  return byId;
}
