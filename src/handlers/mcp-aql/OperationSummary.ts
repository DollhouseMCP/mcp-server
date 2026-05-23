import { ALL_OPERATION_SCHEMAS } from './OperationSchema.js';
import type { ActiveElement } from './policies/index.js';
import type { CliApprovalPolicy, CliApprovalScope } from './GatekeeperTypes.js';

function namedAction(name: string, withName: string, withoutName: string): string {
  return name ? withName : withoutName;
}

export function buildOperationSummary(
  operation: string,
  elementType?: string,
  params?: Record<string, unknown>
): string {
  const p = params || {};
  const name = (p.element_name || p.name || '') as string;
  const typeLabel = elementType || (p.element_type as string) || 'element';
  const directSummary = buildKnownOperationSummary(operation, name, typeLabel, p);
  return directSummary ?? buildFallbackOperationSummary(operation, elementType, p);
}

function buildKnownOperationSummary(
  operation: string,
  name: string,
  typeLabel: string,
  p: Record<string, unknown>
): string | undefined {
  const summaries: Record<string, string | undefined> = {
    create_element: namedAction(name, `Create a new ${typeLabel} called "${name}"`, `Create a new ${typeLabel}`),
    edit_element: namedAction(name, `Edit the ${typeLabel} "${name}"`, `Edit a ${typeLabel}`),
    delete_element: namedAction(name, `Permanently delete the ${typeLabel} "${name}"`, `Permanently delete a ${typeLabel}`),
    activate_element: namedAction(name, `Activate the ${typeLabel} "${name}" (changes active permission surface)`, `Activate a ${typeLabel}`),
    deactivate_element: namedAction(name, `Deactivate the ${typeLabel} "${name}"`, `Deactivate a ${typeLabel}`),
    execute_agent: buildExecuteSummary(name, p),
    install_collection_content: buildInstallSummary(p),
    submit_collection_content: 'Submit a local element to the community collection',
    clear: typeLabel === 'element' ? 'Clear data' : `Clear all ${typeLabel} data`,
  };
  return summaries[operation];
}

function buildExecuteSummary(name: string, p: Record<string, unknown>): string {
  const goal = (p.goal || '') as string;
  const goalSuffix = goal ? ` with goal: ${goal}` : '';
  return name ? `Run the agent "${name}"${goalSuffix}` : `Execute an agent${goalSuffix}`;
}

function buildInstallSummary(p: Record<string, unknown>): string {
  const path = (p.path || '') as string;
  return path
    ? `Install "${path}" from the community collection to your portfolio`
    : 'Install an element from the community collection';
}

function buildFallbackOperationSummary(
  operation: string,
  elementType: string | undefined,
  p: Record<string, unknown>
): string {
  const schema = ALL_OPERATION_SCHEMAS[operation];
  const paramKeys = Object.keys(p).filter(k => k !== 'operation');
  const paramHint = paramKeys.length > 0 ? ` (${paramKeys.join(', ')})` : '';
  if (schema?.description) {
    return `${schema.description}${paramHint}`;
  }
  const elementTypeNote = elementType ? ` on ${elementType}` : '';
  return `Perform operation: ${operation.replaceAll('_', ' ')}${paramHint}${elementTypeNote}`;
}

export function buildInvalidPolicyAdvisory(invalidPolicyCount: number): string {
  const singular = invalidPolicyCount === 1;
  return `${invalidPolicyCount} active element${singular ? '' : 's'} ha${singular ? 's' : 've'} malformed gatekeeper policy. The element${singular ? ' remains' : 's remain'} active, but that policy is not enforceable until fixed.`;
}

export function resolveCliApprovalPolicy(activeElements: ActiveElement[]): CliApprovalPolicy {
  const policy = collectElementApprovalPolicy(activeElements);
  if (policy.requireApproval?.length) {
    return policy;
  }
  return {
    ...policy,
    requireApproval: parseEnvApprovalPolicy(),
  };
}

function collectElementApprovalPolicy(activeElements: ActiveElement[]): CliApprovalPolicy {
  const requireApproval = new Set<'moderate' | 'dangerous'>();
  let defaultScope: CliApprovalScope | undefined;
  let ttlSeconds: number | undefined;

  for (const element of activeElements) {
    const policy = element.metadata?.gatekeeper?.externalRestrictions?.approvalPolicy;
    if (!policy) {
      continue;
    }
    policy.requireApproval?.forEach(level => requireApproval.add(level));
    defaultScope = defaultScope ?? policy.defaultScope;
    ttlSeconds = policy.ttlSeconds === undefined
      ? ttlSeconds
      : Math.min(ttlSeconds ?? policy.ttlSeconds, policy.ttlSeconds);
  }

  return {
    requireApproval: requireApproval.size > 0 ? Array.from(requireApproval) : undefined,
    defaultScope,
    ttlSeconds,
  };
}

function parseEnvApprovalPolicy(): Array<'moderate' | 'dangerous'> | undefined {
  const envPolicy = process.env.DOLLHOUSE_CLI_APPROVAL_POLICY;
  const levels = envPolicy?.split(',')
    .map(s => s.trim())
    .filter((s): s is 'moderate' | 'dangerous' => s === 'moderate' || s === 'dangerous') ?? [];
  return levels.length > 0 ? levels : undefined;
}
