import { OPERATION_ROUTES, getRoute, type CRUDEndpoint, type OperationRoute } from './OperationRouter.js';
import { ALL_OPERATION_SCHEMAS, getOperationSchema, type OperationDef, type ParamSchema, type ParamType } from './OperationSchema.js';
import { getIntegrationReadTools } from '../../server/tools/IntegrationTools.js';
import type { ToolHandler } from '../types/ToolTypes.js';
import type { AuthorizedIntegrationOperationCatalog } from '../../web-console/modules/integrations/AuthorizedIntegrationGateway.js';

const INTEGRATION_READ_NAMES: Readonly<Record<string, string>> = {
  list_operations: 'list_integration_operations',
  describe_operation: 'describe_integration_operation',
};

/** A fixed operation set for one handler. Shared route/schema tables stay unchanged. */
export class OperationRegistry {
  readonly routes: Readonly<Record<string, OperationRoute>>;
  readonly schemas: Readonly<Record<string, OperationDef>>;
  private readonly integrationHandlers = new Map<string, ToolHandler>();

  constructor(catalog?: AuthorizedIntegrationOperationCatalog) {
    const routes = { ...OPERATION_ROUTES };
    const schemas = { ...ALL_OPERATION_SCHEMAS };
    for (const { tool, handler } of catalog ? getIntegrationReadTools(catalog) : []) {
      const name = INTEGRATION_READ_NAMES[tool.name];
      const description = tool.description ?? name;
      const params: ParamSchema = {};
      for (const [key, value] of Object.entries(tool.inputSchema.properties ?? {})) {
        const property = value as { type: ParamType; description?: string };
        params[key] = { ...property, required: tool.inputSchema.required?.includes(key) ?? false };
      }
      routes[name] = { endpoint: 'READ', handler: `Integration.${name}`, description };
      schemas[name] = {
        endpoint: 'READ', handler: 'mcpAqlHandler', method: name,
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
