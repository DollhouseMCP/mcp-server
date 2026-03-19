/**
 * Gatekeeper Policies Module
 *
 * Exports all policy-related functions and types for the Gatekeeper Policy Engine.
 */

// Operation policies
export {
  OPERATION_POLICIES,
  OPERATION_POLICY_OVERRIDES,
  getEndpointDefaultLevel,
  getOperationPolicy,
  getDefaultPermissionLevel,
  canOperationBeElevated,
  getOperationsAtLevel,
  getAutoApprovedOperations,
  getConfirmationRequiredOperations,
} from './OperationPolicies.js';

// Element policies
export {
  resolveElementPolicy,
  createDecisionFromPolicy,
  parseElementPolicy,
  sanitizeGatekeeperPolicy,
  type ElementMetadataWithPolicy,
  type ActiveElement,
  type ElementPolicyResult,
} from './ElementPolicies.js';

// Agent tool policy translation (Issue #449)
export { translateToolConfigToPolicy } from './AgentToolPolicyTranslator.js';

// CLI-level tool classification (Issue #625)
export {
  classifyTool,
  evaluateCliToolPolicy,
  type ToolClassificationResult,
  type CliToolPolicyResult,
  type ToolRiskLevel,
} from './ToolClassification.js';
