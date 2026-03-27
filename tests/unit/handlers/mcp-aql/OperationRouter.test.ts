/**
 * Unit tests for OperationRouter
 *
 * Tests the operation routing table that maps MCP operations to
 * CRUD endpoints and handler implementations.
 */

import {
  CRUDEndpoint,
  OperationRoute,
  OPERATION_ROUTES,
  getRoute,
  getOperationsForEndpoint,
} from '../../../../src/handlers/mcp-aql/OperationRouter.js';

describe('OperationRouter', () => {
  // Canonical list of all operations — add new operations here when registering them in OPERATION_ROUTES
  const expectedOperations = [
        // CREATE operations
        'create_element',
        'import_element',
        'addEntry',
        'verify_challenge',
        'beetlejuice_beetlejuice_beetlejuice',
        'install_collection_content',
        'submit_collection_content',
        'setup_github_auth',
        'configure_oauth',
        'import_persona',
        'init_portfolio',
        'sync_portfolio',
        'portfolio_element_manager',
        'record_execution_step',
        // READ operations
        'search', // Unified search (Issue #243)
        'list_elements',
        'get_element',
        'get_element_details',
        'search_elements',
        'query_elements',
        'get_active_elements',
        'validate_element',
        'render',
        'export_element',
        'activate_element',
        'deactivate_element',
        'open_portfolio_browser',
        'introspect',
        'browse_collection',
        'search_collection',
        'search_collection_enhanced',
        'get_collection_content',
        'get_collection_cache_health',
        'check_github_auth',
        'oauth_helper_status',
        'dollhouse_config',
        'convert_skill_format',
        'get_build_info',
        'get_cache_budget_report',
        'portfolio_status',
        'portfolio_config',
        'search_portfolio',
        'search_all',
        'find_similar_elements',
        'get_element_relationships',
        'search_by_verb',
        'get_relationship_stats',
        'get_execution_state',
        'get_gathered_data',
        'permission_prompt', // Issue #647: Moved from EXECUTE to READ
        'evaluate_permission', // Permission evaluation for PreToolUse hooks (all platforms)
        // LOGGING operations (Issue #528)
        'query_logs',
        // METRICS operations
        'query_metrics',
        // UPDATE operations
        'edit_element',
        'upgrade_element',
        // DELETE operations
        'delete_element',
        'clear',
        'clear_github_auth',
        // EXECUTE operations (Issue #244 - CRUDE)
        'execute_agent',
        'complete_execution',
        'continue_execution',
        'abort_execution',
        'prepare_handoff',
        'resume_from_handoff',
      'confirm_operation',
      'get_effective_cli_policies', // Issue #625 Phase 2
      'approve_cli_permission', // Issue #625 Phase 3
      'get_pending_cli_approvals', // Issue #625 Phase 3
  ];

  describe('OPERATION_ROUTES constant', () => {
    it('should define routes for all expected operations', () => {
      expectedOperations.forEach((operation) => {
        expect(OPERATION_ROUTES[operation]).toBeDefined();
        expect(OPERATION_ROUTES[operation]).toHaveProperty('endpoint');
        expect(OPERATION_ROUTES[operation]).toHaveProperty('handler');
      });
    });

    it('should have at least one operation defined', () => {
      const operationCount = Object.keys(OPERATION_ROUTES).length;
      expect(operationCount).toBeGreaterThan(0);
    });

    it('should have every operation accounted for in expectedOperations list', () => {
      const actualOps = Object.keys(OPERATION_ROUTES).sort();
      const expectedOps = [...expectedOperations].sort();
      expect(actualOps).toEqual(expectedOps);
    });

    it('should have valid CRUDE endpoints for all routes', () => {
      const validEndpoints: CRUDEndpoint[] = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'EXECUTE'];

      Object.values(OPERATION_ROUTES).forEach((route) => {
        expect(validEndpoints).toContain(route.endpoint);
      });
    });

    it('should have non-empty handler strings for all routes', () => {
      Object.values(OPERATION_ROUTES).forEach((route) => {
        expect(route.handler).toBeTruthy();
        expect(typeof route.handler).toBe('string');
        expect(route.handler.length).toBeGreaterThan(0);
      });
    });
  });

  describe('CREATE endpoint operations', () => {
    it('should map create_element to CREATE endpoint', () => {
      const route = OPERATION_ROUTES.create_element;
      expect(route.endpoint).toBe('CREATE');
      expect(route.handler).toBe('ElementCRUD.create');
    });

    it('should map import_element to CREATE endpoint', () => {
      const route = OPERATION_ROUTES.import_element;
      expect(route.endpoint).toBe('CREATE');
      expect(route.handler).toBe('ElementCRUD.import');
    });

    it('should map addEntry to CREATE endpoint', () => {
      const route = OPERATION_ROUTES.addEntry;
      expect(route.endpoint).toBe('CREATE');
      expect(route.handler).toBe('Memory.addEntry');
    });

    it('should map activate_element to READ endpoint', () => {
      const route = OPERATION_ROUTES.activate_element;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('Activation.activate');
    });

    it('should include expected CREATE operations', () => {
      const createOps = getOperationsForEndpoint('CREATE');
      expect(createOps.length).toBeGreaterThan(0);
      expect(createOps).toContain('create_element');
      expect(createOps).toContain('record_execution_step');
    });
  });

  describe('READ endpoint operations', () => {
    it('should map list_elements to READ endpoint', () => {
      const route = OPERATION_ROUTES.list_elements;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('ElementCRUD.list');
    });

    it('should map get_element to READ endpoint', () => {
      const route = OPERATION_ROUTES.get_element;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('ElementCRUD.get');
    });

    it('should map get_element_details to READ endpoint', () => {
      const route = OPERATION_ROUTES.get_element_details;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('ElementCRUD.getDetails');
    });

    it('should map search_elements to READ endpoint', () => {
      const route = OPERATION_ROUTES.search_elements;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('Search.search');
    });

    it('should map unified search to READ endpoint (Issue #243)', () => {
      const route = OPERATION_ROUTES.search;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('UnifiedSearch.search');
      expect(route.description).toContain('Unified search');
    });

    it('should map query_elements to READ endpoint', () => {
      const route = OPERATION_ROUTES.query_elements;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('Search.query');
    });

    it('should map get_active_elements to READ endpoint', () => {
      const route = OPERATION_ROUTES.get_active_elements;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('Activation.getActive');
    });

    it('should map validate_element to READ endpoint', () => {
      const route = OPERATION_ROUTES.validate_element;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('ElementCRUD.validate');
    });

    it('should map render to READ endpoint', () => {
      const route = OPERATION_ROUTES.render;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('Template.render');
    });

    it('should map export_element to READ endpoint', () => {
      const route = OPERATION_ROUTES.export_element;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('ElementCRUD.export');
    });

    it('should map deactivate_element to READ endpoint', () => {
      const route = OPERATION_ROUTES.deactivate_element;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('Activation.deactivate');
    });

    it('should map introspect to READ endpoint', () => {
      const route = OPERATION_ROUTES.introspect;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('Introspection.resolve');
    });

    it('should map convert_skill_format to READ endpoint', () => {
      const route = OPERATION_ROUTES.convert_skill_format;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('Config.convertSkillFormat');
    });

    it('should include expected READ operations', () => {
      const readOps = getOperationsForEndpoint('READ');
      expect(readOps.length).toBeGreaterThan(0);
      expect(readOps).toContain('get_execution_state');
      expect(readOps).toContain('get_gathered_data');
    });
  });

  describe('UPDATE endpoint operations', () => {
    it('should map edit_element to UPDATE endpoint', () => {
      const route = OPERATION_ROUTES.edit_element;
      expect(route.endpoint).toBe('UPDATE');
      expect(route.handler).toBe('ElementCRUD.edit');
    });

    it('should include expected UPDATE operations', () => {
      const updateOps = getOperationsForEndpoint('UPDATE');
      expect(updateOps.length).toBeGreaterThan(0);
      expect(updateOps).toContain('edit_element');
    });
  });

  describe('DELETE endpoint operations', () => {
    it('should map delete_element to DELETE endpoint', () => {
      const route = OPERATION_ROUTES.delete_element;
      expect(route.endpoint).toBe('DELETE');
      expect(route.handler).toBe('ElementCRUD.delete');
    });

    it('should map clear to DELETE endpoint', () => {
      const route = OPERATION_ROUTES.clear;
      expect(route.endpoint).toBe('DELETE');
      expect(route.handler).toBe('Memory.clear');
    });

    it('should include expected DELETE operations', () => {
      const deleteOps = getOperationsForEndpoint('DELETE');
      expect(deleteOps.length).toBeGreaterThan(0);
      expect(deleteOps).toContain('delete_element');
      expect(deleteOps).toContain('clear');
    });
  });

  describe('EXECUTE endpoint operations (Issue #244)', () => {
    it('should map execute_agent to EXECUTE endpoint', () => {
      const route = OPERATION_ROUTES.execute_agent;
      expect(route.endpoint).toBe('EXECUTE');
      expect(route.handler).toBe('Execute.execute');
    });

    it('should map get_execution_state to READ endpoint', () => {
      const route = OPERATION_ROUTES.get_execution_state;
      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('Execute.getState');
    });

    it('should map record_execution_step to CREATE endpoint', () => {
      const route = OPERATION_ROUTES.record_execution_step;
      expect(route.endpoint).toBe('CREATE');
      expect(route.handler).toBe('Execute.updateState');
    });

    it('should map complete_execution to EXECUTE endpoint', () => {
      const route = OPERATION_ROUTES.complete_execution;
      expect(route.endpoint).toBe('EXECUTE');
      expect(route.handler).toBe('Execute.complete');
    });

    it('should map continue_execution to EXECUTE endpoint', () => {
      const route = OPERATION_ROUTES.continue_execution;
      expect(route.endpoint).toBe('EXECUTE');
      expect(route.handler).toBe('Execute.continue');
    });

    it('should route abort_execution to Execute.abort handler (Issue #249)', () => {
      const route = getRoute('abort_execution');
      expect(route).toBeDefined();
      expect(route!.endpoint).toBe('EXECUTE');
      expect(route!.handler).toBe('Execute.abort');
    });

    it('should include expected EXECUTE operations', () => {
      const executeOps = getOperationsForEndpoint('EXECUTE');
      expect(executeOps.length).toBeGreaterThan(0);
      expect(executeOps).toContain('execute_agent');
      expect(executeOps).toContain('abort_execution');
      expect(executeOps).toContain('confirm_operation');
      // These moved to READ/CREATE — verify they're NOT here
      expect(executeOps).not.toContain('get_execution_state');
      expect(executeOps).not.toContain('record_execution_step');
      expect(executeOps).not.toContain('get_gathered_data');
    });
  });

  describe('getRoute() helper function', () => {
    it('should return route for valid operation', () => {
      const route = getRoute('create_element');
      expect(route).toBeDefined();
      expect(route?.endpoint).toBe('CREATE');
      expect(route?.handler).toBe('ElementCRUD.create');
    });

    it('should return undefined for invalid operation', () => {
      const route = getRoute('nonexistent_operation');
      expect(route).toBeUndefined();
    });

    it('should return route with description when present', () => {
      const route = getRoute('create_element');
      expect(route?.description).toBeDefined();
      expect(typeof route?.description).toBe('string');
    });

    it('should handle all defined operations', () => {
      const operations = Object.keys(OPERATION_ROUTES);
      operations.forEach((operation) => {
        const route = getRoute(operation);
        expect(route).toBeDefined();
        expect(route?.endpoint).toBeTruthy();
        expect(route?.handler).toBeTruthy();
      });
    });
  });

  describe('getOperationsForEndpoint() helper function', () => {
    it('should return all CREATE operations', () => {
      const operations = getOperationsForEndpoint('CREATE');
      expect(operations).toContain('create_element');
      expect(operations).toContain('import_element');
      expect(operations).toContain('addEntry');
    });

    it('should return all READ operations', () => {
      const operations = getOperationsForEndpoint('READ');
      expect(operations).toContain('search'); // Unified search (Issue #243)
      expect(operations).toContain('list_elements');
      expect(operations).toContain('get_element');
      expect(operations).toContain('get_element_details');
      expect(operations).toContain('search_elements');
      expect(operations).toContain('query_elements');
      expect(operations).toContain('get_active_elements');
      expect(operations).toContain('validate_element');
      expect(operations).toContain('render');
      expect(operations).toContain('export_element');
      expect(operations).toContain('activate_element');
      expect(operations).toContain('deactivate_element');
      expect(operations).toContain('introspect');
    });

    it('should return all UPDATE operations', () => {
      const operations = getOperationsForEndpoint('UPDATE');
      expect(operations).toContain('edit_element');
    });

    it('should return all DELETE operations', () => {
      const operations = getOperationsForEndpoint('DELETE');
      expect(operations).toContain('delete_element');
      expect(operations).toContain('clear');
      // execute_agent moved to EXECUTE endpoint in Issue #244
    });

    it('should return all EXECUTE operations', () => {
      const operations = getOperationsForEndpoint('EXECUTE');
      expect(operations).toContain('execute_agent');
      expect(operations).toContain('complete_execution');
      expect(operations).toContain('continue_execution');
      expect(operations).toContain('abort_execution');
      // get_execution_state, get_gathered_data moved to READ; record_execution_step moved to CREATE
      expect(operations).not.toContain('get_execution_state');
      expect(operations).not.toContain('record_execution_step');
      expect(operations).not.toContain('get_gathered_data');
    });

    it('should return empty array for non-matching endpoint', () => {
      // This shouldn't happen in practice, but tests the filter logic
      const operations = getOperationsForEndpoint('INVALID' as CRUDEndpoint);
      expect(operations).toEqual([]);
    });

    it('should return unique operation names', () => {
      const allEndpoints: CRUDEndpoint[] = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'EXECUTE'];
      allEndpoints.forEach((endpoint) => {
        const operations = getOperationsForEndpoint(endpoint);
        const uniqueOps = [...new Set(operations)];
        expect(operations).toEqual(uniqueOps);
      });
    });
  });

  describe('Route consistency', () => {
    it('should have all operations covered by getOperationsForEndpoint', () => {
      const allEndpoints: CRUDEndpoint[] = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'EXECUTE'];
      const allOperationsFromHelper: string[] = [];

      allEndpoints.forEach((endpoint) => {
        allOperationsFromHelper.push(...getOperationsForEndpoint(endpoint));
      });

      const allOperationsFromRoutes = Object.keys(OPERATION_ROUTES);

      expect(allOperationsFromHelper.sort()).toEqual(allOperationsFromRoutes.sort());
    });

    it('should have endpoint distribution that sums to total operation count', () => {
      const allEndpoints: CRUDEndpoint[] = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'EXECUTE'];
      const distribution = Object.fromEntries(
        allEndpoints.map(ep => [ep, getOperationsForEndpoint(ep).length])
      );

      // Every endpoint should have at least one operation
      for (const [_endpoint, count] of Object.entries(distribution)) {
        expect(count).toBeGreaterThan(0);
      }

      // Sum of all endpoints must equal total route count
      const total = Object.values(distribution).reduce((sum, count) => sum + count, 0);
      expect(total).toBe(Object.keys(OPERATION_ROUTES).length);
    });
  });

  describe('Type safety', () => {
    it('should enforce OperationRoute interface structure', () => {
      const route: OperationRoute = {
        endpoint: 'CREATE',
        handler: 'Test.handler',
        description: 'Test description',
      };

      expect(route.endpoint).toBe('CREATE');
      expect(route.handler).toBe('Test.handler');
      expect(route.description).toBe('Test description');
    });

    it('should allow OperationRoute without description', () => {
      const route: OperationRoute = {
        endpoint: 'READ',
        handler: 'Test.handler',
      };

      expect(route.endpoint).toBe('READ');
      expect(route.handler).toBe('Test.handler');
      expect(route.description).toBeUndefined();
    });
  });
});
