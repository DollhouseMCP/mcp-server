/** Strict management actions; names and policy targets are server-owned. */
export const INTEGRATION_MANAGEMENT_OPERATIONS = {
  create_integration_spec: { endpoint: 'CREATE', resource: 'openapi_spec', action: 'create', method: 'createSpec' },
  update_integration_spec: { endpoint: 'UPDATE', resource: 'openapi_spec', action: 'update', method: 'updateSpec' },
  create_integration_skill: { endpoint: 'CREATE', resource: 'generated_skill', action: 'create', method: 'createSkill' },
  update_integration_skill: { endpoint: 'UPDATE', resource: 'generated_skill', action: 'update', method: 'updateSkill' },
} as const;

export type IntegrationManagementOperation = keyof typeof INTEGRATION_MANAGEMENT_OPERATIONS;

export function isIntegrationManagementOperation(operation: string): operation is IntegrationManagementOperation {
  return Object.hasOwn(INTEGRATION_MANAGEMENT_OPERATIONS, operation);
}

/** These operations own exact-input authorization inside the integration boundary. */
export function isIntegrationPolicyOperation(operation: string): boolean {
  return operation === 'integration_request' || isIntegrationManagementOperation(operation);
}
