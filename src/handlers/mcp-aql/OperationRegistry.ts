import { INTEGRATION_MANAGEMENT_OPERATIONS, isIntegrationManagementOperation } from './IntegrationManagementOperations.js';
import { OPERATION_ROUTES, getRoute, type CRUDEndpoint, type OperationRoute } from './OperationRouter.js';
import { ALL_OPERATION_SCHEMAS, getOperationSchema, type OperationDef, type ParamSchema, type ParamType } from './OperationSchema.js';
import { getIntegrationTools, getIntegrationReadTools, getIntegrationManagementTools } from '../../server/tools/IntegrationTools.js';
import type { ToolHandler } from '../types/ToolTypes.js';
import type { AuthorizedIntegrationGateway, AuthorizedIntegrationOperationCatalog } from '../../web-console/modules/integrations/AuthorizedIntegrationGateway.js';

const INTEGRATION_READ_NAMES: Readonly<Record<string, string>> = {
  list_operations: 'list_integration_operations',
  describe_operation: 'describe_integration_operation',
};

/** A fixed operation set for one handler. Shared route/schema tables stay unchanged. */
export class OperationRegistry {
  readonly routes: Readonly<Record<string, OperationRoute>>;
  readonly schemas: Readonly<Record<string, OperationDef>>;
  private readonly integrationHandlers = new Map<string, ToolHandler>();

  constructor(catalog?: AuthorizedIntegrationOperationCatalog, gateway?: AuthorizedIntegrationGateway) {
    const routes = { ...OPERATION_ROUTES };
    const schemas = { ...ALL_OPERATION_SCHEMAS };
    const tools = [
      ...(catalog ? [...getIntegrationReadTools(catalog), ...getIntegrationManagementTools(catalog, this)] : []),
      ...(gateway ? getIntegrationTools(gateway, undefined, false) : []),
    ];
    for (const { tool, handler } of tools) {
      const name = INTEGRATION_READ_NAMES[tool.name] ?? tool.name;
      const endpoint = integrationEndpoint(name);
      const description = tool.description ?? name;
      const params: ParamSchema = {};
      for (const [key, value] of Object.entries(tool.inputSchema.properties ?? {})) {
        const property = value as { type?: ParamType; description?: string };
        params[key] = { ...property, type: property.type ?? 'unknown', required: tool.inputSchema.required?.includes(key) ?? false };
      }
      routes[name] = { endpoint, handler: `Integration.${name}`, description };
      schemas[name] = {
        endpoint, handler: 'mcpAqlHandler', method: name,
        description, params, category: 'Integrations',
      };
      this.integrationHandlers.set(name, handler);
    }
    this.routes = Object.freeze(routes);
    this.schemas = Object.freeze(schemas);
  }

  getRoute(operation: string): OperationRoute | undefined {
    return getRoute(operation, this.routes);
  }

  getSchema(operation: string): OperationDef | undefined {
    return Object.hasOwn(this.schemas, operation) ? this.schemas[operation] : undefined;
  }

  getDispatchSchema(operation: string): OperationDef | undefined {
    return this.integrationHandlers.has(operation) ? this.getSchema(operation) : getOperationSchema(operation);
  }

  getIntegrationHandler(operation: string): ToolHandler | undefined {
    return this.integrationHandlers.get(operation);
  }

  getOperationsForEndpoint(endpoint: CRUDEndpoint): string[] {
    return Object.keys(this.routes).filter(name => this.routes[name].endpoint === endpoint);
  }
}

export const BASE_OPERATION_REGISTRY = new OperationRegistry();

function integrationEndpoint(name: string): CRUDEndpoint {
  if (name === 'integration_request') return 'EXECUTE';
  if (isIntegrationManagementOperation(name)) return INTEGRATION_MANAGEMENT_OPERATIONS[name].endpoint;
  return 'READ';
}
