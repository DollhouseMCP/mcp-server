/**
 * Unit tests for OperationSchema
 *
 * Tests the schema definitions for MCP-AQL operations including:
 * - Schema structure validation
 * - Operation lookup functions
 * - Parameter definitions
 * - Handler mappings
 */

import {
  SCHEMA_DRIVEN_OPERATIONS,
  COLLECTION_OPERATIONS,
  AUTH_OPERATIONS,
  ENHANCED_INDEX_OPERATIONS,
  TEMPLATE_OPERATIONS,
  INTROSPECTION_OPERATIONS,
  PERSONA_OPERATIONS,
  CONFIG_OPERATIONS,
  PORTFOLIO_OPERATIONS,
  ELEMENT_CRUD_OPERATIONS,
  MEMORY_SCHEMAS,
  EXECUTION_SCHEMAS,
  GATEKEEPER_SCHEMAS,
  LOGGING_SCHEMAS,
  METRICS_SCHEMAS,
  ACTIVATION_SCHEMAS,
  SEARCH_SCHEMAS,
  BROWSER_SCHEMAS,
  INTROSPECTION_ONLY_SCHEMAS,
  ALL_OPERATION_SCHEMAS,
  isSchemaOperation,
  getOperationSchema,
  hasOperationSchema,
  getAnyOperationSchema,
  schemaToParameterInfo,
  getAllSchemaOperations,
  getAllOperationSchemas,
} from '../../../../src/handlers/mcp-aql/OperationSchema.js';

describe('OperationSchema', () => {
  describe('SCHEMA_DRIVEN_OPERATIONS', () => {
    it('should contain all module-specific operations', () => {
      const allModuleOps = {
        ...COLLECTION_OPERATIONS,
        ...AUTH_OPERATIONS,
        ...ENHANCED_INDEX_OPERATIONS,
        ...TEMPLATE_OPERATIONS,
        ...INTROSPECTION_OPERATIONS,
        ...PERSONA_OPERATIONS,
        ...CONFIG_OPERATIONS,
        ...PORTFOLIO_OPERATIONS,
      };

      expect(Object.keys(SCHEMA_DRIVEN_OPERATIONS)).toEqual(
        expect.arrayContaining(Object.keys(allModuleOps))
      );
    });

    it('should have valid structure for all operations', () => {
      for (const [_name, def] of Object.entries(SCHEMA_DRIVEN_OPERATIONS)) {
        expect(def.endpoint).toMatch(/^(CREATE|READ|UPDATE|DELETE|EXECUTE)$/);
        expect(def.handler).toBeTruthy();
        expect(def.method).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(typeof def.description).toBe('string');
      }
    });
  });

  describe('COLLECTION_OPERATIONS', () => {
    it('should define 7 collection operations', () => {
      expect(Object.keys(COLLECTION_OPERATIONS)).toHaveLength(7);
    });

    it('should mark all as optional handlers', () => {
      for (const def of Object.values(COLLECTION_OPERATIONS)) {
        expect(def.optional).toBe(true);
      }
    });

    it('should use collectionHandler for all', () => {
      for (const def of Object.values(COLLECTION_OPERATIONS)) {
        expect(def.handler).toBe('collectionHandler');
      }
    });

    it('should have correct endpoints', () => {
      expect(COLLECTION_OPERATIONS.browse_collection.endpoint).toBe('READ');
      expect(COLLECTION_OPERATIONS.search_collection.endpoint).toBe('READ');
      expect(COLLECTION_OPERATIONS.install_collection_content.endpoint).toBe('CREATE');
      expect(COLLECTION_OPERATIONS.submit_collection_content.endpoint).toBe('CREATE');
    });

    it('should define required params correctly', () => {
      expect(COLLECTION_OPERATIONS.search_collection.params?.query?.required).toBe(true);
      expect(COLLECTION_OPERATIONS.get_collection_content.params?.path?.required).toBe(true);
      expect(COLLECTION_OPERATIONS.browse_collection.params?.section?.required).toBeUndefined();
    });
  });

  describe('AUTH_OPERATIONS', () => {
    it('should define 5 auth operations', () => {
      expect(Object.keys(AUTH_OPERATIONS)).toHaveLength(5);
    });

    it('should use authHandler for all', () => {
      for (const def of Object.values(AUTH_OPERATIONS)) {
        expect(def.handler).toBe('authHandler');
      }
    });

    it('should have correct endpoints', () => {
      expect(AUTH_OPERATIONS.setup_github_auth.endpoint).toBe('CREATE');
      expect(AUTH_OPERATIONS.check_github_auth.endpoint).toBe('READ');
      expect(AUTH_OPERATIONS.clear_github_auth.endpoint).toBe('DELETE');
    });
  });

  describe('ENHANCED_INDEX_OPERATIONS', () => {
    it('should define 4 enhanced index operations', () => {
      expect(Object.keys(ENHANCED_INDEX_OPERATIONS)).toHaveLength(4);
    });

    it('should use named argBuilder for complex params', () => {
      expect(ENHANCED_INDEX_OPERATIONS.find_similar_elements.argBuilder).toBe('named');
      expect(ENHANCED_INDEX_OPERATIONS.get_element_relationships.argBuilder).toBe('named');
      expect(ENHANCED_INDEX_OPERATIONS.search_by_verb.argBuilder).toBe('named');
    });

    it('should define param mappings', () => {
      const params = ENHANCED_INDEX_OPERATIONS.find_similar_elements.params!;
      expect(params.element_name.mapTo).toBe('elementName');
      expect(params.element_type.mapTo).toBe('elementType');
    });

    it('should have default values', () => {
      const params = ENHANCED_INDEX_OPERATIONS.find_similar_elements.params!;
      expect(params.limit.default).toBe(10);
      expect(params.threshold.default).toBe(0.5);
    });
  });

  describe('TEMPLATE_OPERATIONS', () => {
    it('should define render operation', () => {
      expect(TEMPLATE_OPERATIONS.render).toBeDefined();
      expect(TEMPLATE_OPERATIONS.render.handler).toBe('templateRenderer');
      expect(TEMPLATE_OPERATIONS.render.method).toBe('render');
    });

    it('should require element_name param', () => {
      // Issue #290: Use element_name for consistency
      expect(TEMPLATE_OPERATIONS.render.params?.element_name?.required).toBe(true);
    });
  });

  describe('INTROSPECTION_OPERATIONS', () => {
    it('should define introspect operation', () => {
      expect(INTROSPECTION_OPERATIONS.introspect).toBeDefined();
      expect(INTROSPECTION_OPERATIONS.introspect.method).toBe('__introspect__');
    });

    it('should require query param', () => {
      expect(INTROSPECTION_OPERATIONS.introspect.params?.query?.required).toBe(true);
    });
  });

  describe('PERSONA_OPERATIONS', () => {
    it('should define import_persona operation', () => {
      expect(PERSONA_OPERATIONS.import_persona).toBeDefined();
      expect(PERSONA_OPERATIONS.import_persona.handler).toBe('personaHandler');
    });
  });

  describe('CONFIG_OPERATIONS', () => {
    it('should define config, conversion, and build info operations', () => {
      expect(CONFIG_OPERATIONS.dollhouse_config).toBeDefined();
      expect(CONFIG_OPERATIONS.convert_skill_format).toBeDefined();
      expect(CONFIG_OPERATIONS.get_build_info).toBeDefined();
    });

    it('should use special method marker for build info', () => {
      expect(CONFIG_OPERATIONS.get_build_info.method).toBe('__buildInfo__');
    });

    it('should use configHandler conversion method for convert_skill_format', () => {
      expect(CONFIG_OPERATIONS.convert_skill_format.handler).toBe('configHandler');
      expect(CONFIG_OPERATIONS.convert_skill_format.method).toBe('convertSkillFormat');
      expect(CONFIG_OPERATIONS.convert_skill_format.endpoint).toBe('READ');
    });

    it('should define path_mode for safe/lossless conversion behavior', () => {
      expect(CONFIG_OPERATIONS.convert_skill_format.params?.path_mode).toBeDefined();
      expect(CONFIG_OPERATIONS.convert_skill_format.params?.path_mode?.default).toBe('safe');
    });

    it('should default security_mode to strict for agent conversion safety', () => {
      expect(CONFIG_OPERATIONS.convert_skill_format.params?.security_mode).toBeDefined();
      expect(CONFIG_OPERATIONS.convert_skill_format.params?.security_mode?.default).toBe('strict');
    });
  });

  describe('PORTFOLIO_OPERATIONS (Issue #252)', () => {
    // Unified 'search' operation (Issue #243) is now schema-driven with normalizer
    it('should define 8 Portfolio operations', () => {
      expect(Object.keys(PORTFOLIO_OPERATIONS)).toHaveLength(8);
    });

    it('should use portfolioHandler for most operations', () => {
      expect(PORTFOLIO_OPERATIONS.portfolio_status.handler).toBe('portfolioHandler');
      expect(PORTFOLIO_OPERATIONS.init_portfolio.handler).toBe('portfolioHandler');
      expect(PORTFOLIO_OPERATIONS.portfolio_config.handler).toBe('portfolioHandler');
      expect(PORTFOLIO_OPERATIONS.sync_portfolio.handler).toBe('portfolioHandler');
      expect(PORTFOLIO_OPERATIONS.search_portfolio.handler).toBe('portfolioHandler');
      expect(PORTFOLIO_OPERATIONS.search_all.handler).toBe('portfolioHandler');
    });

    it('should use syncHandler for portfolio_element_manager', () => {
      expect(PORTFOLIO_OPERATIONS.portfolio_element_manager.handler).toBe('syncHandler');
    });

    it('should use paramStyle snakeToCamel for param conversion', () => {
      expect(PORTFOLIO_OPERATIONS.init_portfolio.paramStyle).toBe('snakeToCamel');
      expect(PORTFOLIO_OPERATIONS.portfolio_config.paramStyle).toBe('snakeToCamel');
      expect(PORTFOLIO_OPERATIONS.sync_portfolio.paramStyle).toBe('snakeToCamel');
      expect(PORTFOLIO_OPERATIONS.search_portfolio.paramStyle).toBe('snakeToCamel');
      expect(PORTFOLIO_OPERATIONS.search_all.paramStyle).toBe('snakeToCamel');
    });

    it('should have correct endpoints', () => {
      expect(PORTFOLIO_OPERATIONS.portfolio_status.endpoint).toBe('READ');
      expect(PORTFOLIO_OPERATIONS.portfolio_config.endpoint).toBe('READ');
      expect(PORTFOLIO_OPERATIONS.search_portfolio.endpoint).toBe('READ');
      expect(PORTFOLIO_OPERATIONS.search_all.endpoint).toBe('READ');
      expect(PORTFOLIO_OPERATIONS.init_portfolio.endpoint).toBe('CREATE');
      expect(PORTFOLIO_OPERATIONS.sync_portfolio.endpoint).toBe('CREATE');
      expect(PORTFOLIO_OPERATIONS.portfolio_element_manager.endpoint).toBe('CREATE');
    });

    it('should define unified search operation with normalizer (Issue #243)', () => {
      expect(PORTFOLIO_OPERATIONS.search).toBeDefined();
      expect(PORTFOLIO_OPERATIONS.search.handler).toBe('portfolioHandler');
      expect(PORTFOLIO_OPERATIONS.search.method).toBe('searchAll');
      expect(PORTFOLIO_OPERATIONS.search.normalizer).toBe('searchParams');
      expect(PORTFOLIO_OPERATIONS.search.argBuilder).toBe('named');
      expect(PORTFOLIO_OPERATIONS.search.params?.query?.required).toBe(true);
    });

    it('should define required params correctly', () => {
      expect(PORTFOLIO_OPERATIONS.search_portfolio.params?.query?.required).toBe(true);
      expect(PORTFOLIO_OPERATIONS.search_all.params?.query?.required).toBe(true);
      expect(PORTFOLIO_OPERATIONS.portfolio_element_manager.params?.operation?.required).toBe(true);
    });

    it('should use named argBuilder for most operations', () => {
      expect(PORTFOLIO_OPERATIONS.init_portfolio.argBuilder).toBe('named');
      expect(PORTFOLIO_OPERATIONS.portfolio_config.argBuilder).toBe('named');
      expect(PORTFOLIO_OPERATIONS.sync_portfolio.argBuilder).toBe('named');
      expect(PORTFOLIO_OPERATIONS.search_portfolio.argBuilder).toBe('named');
      expect(PORTFOLIO_OPERATIONS.search_all.argBuilder).toBe('named');
    });

    it('should have mapTo override for type param in search operations', () => {
      expect(PORTFOLIO_OPERATIONS.search_portfolio.params?.type?.mapTo).toBe('elementType');
      expect(PORTFOLIO_OPERATIONS.search_all.params?.type?.mapTo).toBe('elementType');
    });
  });

  describe('ELEMENT_CRUD_OPERATIONS (Issue #251)', () => {
    it('should define 10 ElementCRUD operations', () => {
      expect(Object.keys(ELEMENT_CRUD_OPERATIONS)).toHaveLength(10);
    });

    it('should use elementCRUD handler for all', () => {
      for (const def of Object.values(ELEMENT_CRUD_OPERATIONS)) {
        expect(def.handler).toBe('elementCRUD');
      }
    });

    it('should have needsFullInput for operations with type sources', () => {
      expect(ELEMENT_CRUD_OPERATIONS.create_element.needsFullInput).toBe(true);
      expect(ELEMENT_CRUD_OPERATIONS.list_elements.needsFullInput).toBe(true);
      expect(ELEMENT_CRUD_OPERATIONS.get_element.needsFullInput).toBe(true);
      expect(ELEMENT_CRUD_OPERATIONS.edit_element.needsFullInput).toBe(true);
      expect(ELEMENT_CRUD_OPERATIONS.delete_element.needsFullInput).toBe(true);
    });

    it('should define type sources for input normalization', () => {
      // Issue #290: element_type is the new canonical name, with input.element_type as primary source
      const typeParam = ELEMENT_CRUD_OPERATIONS.create_element.params?.element_type;
      expect(typeParam?.sources).toEqual(['input.element_type', 'input.elementType', 'params.element_type']);
      expect(typeParam?.required).toBe(true);
    });

    it('should declare gatekeeper param in create_element (Issue #726)', () => {
      const gatekeeperParam = ELEMENT_CRUD_OPERATIONS.create_element.params?.gatekeeper;
      expect(gatekeeperParam).toBeDefined();
      expect(gatekeeperParam?.type).toBe('object');
      expect(gatekeeperParam?.description).toContain('allow');
      expect(gatekeeperParam?.description).toContain('confirm');
      expect(gatekeeperParam?.description).toContain('deny');
    });

    it('should use namedWithType argBuilder for create/edit/validate/delete', () => {
      expect(ELEMENT_CRUD_OPERATIONS.create_element.argBuilder).toBe('namedWithType');
      expect(ELEMENT_CRUD_OPERATIONS.edit_element.argBuilder).toBe('namedWithType');
      expect(ELEMENT_CRUD_OPERATIONS.validate_element.argBuilder).toBe('namedWithType');
      expect(ELEMENT_CRUD_OPERATIONS.delete_element.argBuilder).toBe('namedWithType');
    });

    it('should use appropriate argBuilder for positional operations', () => {
      expect(ELEMENT_CRUD_OPERATIONS.list_elements.argBuilder).toBe('typeWithParams');
      expect(ELEMENT_CRUD_OPERATIONS.get_element.argBuilder).toBe('single');
      expect(ELEMENT_CRUD_OPERATIONS.export_element.argBuilder).toBe('single');
    });

    it('should use special method markers for import/export', () => {
      expect(ELEMENT_CRUD_OPERATIONS.export_element.method).toBe('__export__');
      expect(ELEMENT_CRUD_OPERATIONS.import_element.method).toBe('__import__');
    });

    it('should have correct endpoints', () => {
      expect(ELEMENT_CRUD_OPERATIONS.create_element.endpoint).toBe('CREATE');
      expect(ELEMENT_CRUD_OPERATIONS.list_elements.endpoint).toBe('READ');
      expect(ELEMENT_CRUD_OPERATIONS.get_element.endpoint).toBe('READ');
      expect(ELEMENT_CRUD_OPERATIONS.edit_element.endpoint).toBe('UPDATE');
      expect(ELEMENT_CRUD_OPERATIONS.delete_element.endpoint).toBe('DELETE');
      expect(ELEMENT_CRUD_OPERATIONS.import_element.endpoint).toBe('CREATE');
      expect(ELEMENT_CRUD_OPERATIONS.export_element.endpoint).toBe('READ');
    });
  });

  describe('isSchemaOperation()', () => {
    it('should return true for schema-driven operations', () => {
      expect(isSchemaOperation('browse_collection')).toBe(true);
      expect(isSchemaOperation('setup_github_auth')).toBe(true);
      expect(isSchemaOperation('introspect')).toBe(true);
      expect(isSchemaOperation('render')).toBe(true);
    });

    it('should return false for legacy operations', () => {
      // Operations not yet migrated to schema
      expect(isSchemaOperation('execute_agent')).toBe(false);
      expect(isSchemaOperation('addEntry')).toBe(false);
      expect(isSchemaOperation('activate_element')).toBe(false);
    });

    it('should return true for ElementCRUD operations (Issue #251)', () => {
      // ElementCRUD operations are now schema-driven
      expect(isSchemaOperation('create_element')).toBe(true);
      expect(isSchemaOperation('list_elements')).toBe(true);
      expect(isSchemaOperation('get_element')).toBe(true);
      expect(isSchemaOperation('edit_element')).toBe(true);
      expect(isSchemaOperation('delete_element')).toBe(true);
    });

    it('should return false for unknown operations', () => {
      expect(isSchemaOperation('nonexistent')).toBe(false);
    });
  });

  describe('getOperationSchema()', () => {
    it('should return schema for known operations', () => {
      const schema = getOperationSchema('browse_collection');
      expect(schema).toBeDefined();
      expect(schema?.endpoint).toBe('READ');
      expect(schema?.handler).toBe('collectionHandler');
    });

    it('should return undefined for unknown operations', () => {
      expect(getOperationSchema('nonexistent')).toBeUndefined();
    });

    it('should return undefined for legacy operations', () => {
      // Operations not yet migrated to schema
      expect(getOperationSchema('execute_agent')).toBeUndefined();
      expect(getOperationSchema('addEntry')).toBeUndefined();
    });

    it('should return schema for ElementCRUD operations (Issue #251)', () => {
      const schema = getOperationSchema('create_element');
      expect(schema).toBeDefined();
      expect(schema?.endpoint).toBe('CREATE');
      expect(schema?.handler).toBe('elementCRUD');
      expect(schema?.needsFullInput).toBe(true);
      // Issue #290: element_type is the new canonical name, with input.element_type as primary source
      expect(schema?.params?.element_type?.sources).toEqual(['input.element_type', 'input.elementType', 'params.element_type']);
    });
  });

  /**
   * Issue #254 - Introspection helpers
   */
  describe('schemaToParameterInfo()', () => {
    it('should convert ParamSchema to ParameterInfo array', () => {
      const schema = getOperationSchema('search_collection');
      const params = schemaToParameterInfo(schema?.params);

      expect(params).toHaveLength(1);
      expect(params[0]).toEqual({
        name: 'query',
        type: 'string',
        required: true,
        description: 'Search query',
      });
    });

    it('should include default values when present', () => {
      const schema = getOperationSchema('find_similar_elements');
      const params = schemaToParameterInfo(schema?.params);

      const limitParam = params.find(p => p.name === 'limit');
      expect(limitParam).toBeDefined();
      expect(limitParam?.default).toBe(10);
    });

    it('should return empty array for undefined schema', () => {
      expect(schemaToParameterInfo(undefined)).toEqual([]);
    });

    it('should return empty array for empty params', () => {
      const schema = getOperationSchema('get_collection_cache_health');
      expect(schemaToParameterInfo(schema?.params)).toEqual([]);
    });
  });

  describe('getAllSchemaOperations()', () => {
    it('should return all schema-driven operations', () => {
      const ops = getAllSchemaOperations();

      expect(Object.keys(ops)).toContain('browse_collection');
      expect(Object.keys(ops)).toContain('setup_github_auth');
      expect(Object.keys(ops)).toContain('render');
      expect(Object.keys(ops)).toContain('introspect');
    });

    it('should match SCHEMA_DRIVEN_OPERATIONS', () => {
      const ops = getAllSchemaOperations();
      expect(Object.keys(ops)).toEqual(Object.keys(SCHEMA_DRIVEN_OPERATIONS));
    });
  });

  /**
   * Issue #254 - Introspection fields in schema
   */
  describe('Introspection fields (Issue #254)', () => {
    describe('returns field', () => {
      it('should define returns for collection operations', () => {
        const schema = getOperationSchema('browse_collection');
        expect(schema?.returns).toBeDefined();
        expect(schema?.returns?.name).toBe('CollectionBrowseResult');
        expect(schema?.returns?.kind).toBe('object');
      });

      it('should define returns for template render', () => {
        const schema = getOperationSchema('render');
        expect(schema?.returns).toBeDefined();
        expect(schema?.returns?.name).toBe('RenderResult');
        expect(schema?.returns?.kind).toBe('object');
      });

      it('should define returns for introspect', () => {
        const schema = getOperationSchema('introspect');
        expect(schema?.returns).toBeDefined();
        expect(schema?.returns?.name).toBe('IntrospectionResult');
        expect(schema?.returns?.kind).toBe('object');
      });
    });

    describe('examples field', () => {
      it('should define examples for collection operations', () => {
        const schema = getOperationSchema('search_collection');
        expect(schema?.examples).toBeDefined();
        expect(schema?.examples?.length).toBeGreaterThan(0);
        expect(schema?.examples?.[0]).toContain('search_collection');
      });

      it('should define multiple examples for introspect', () => {
        const schema = getOperationSchema('introspect');
        expect(schema?.examples).toBeDefined();
        expect(schema?.examples?.length).toBe(6);
      });

      it('should define examples for config operations', () => {
        const schema = getOperationSchema('dollhouse_config');
        expect(schema?.examples).toBeDefined();
        expect(schema?.examples?.length).toBe(2);
      });
    });

    describe('all schema operations have introspection fields', () => {
      it('should have returns defined for all operations', () => {
        const ops = getAllSchemaOperations();
        for (const [_name, def] of Object.entries(ops)) {
          expect(def.returns).toBeDefined();
          expect(def.returns?.name).toBeTruthy();
          expect(def.returns?.kind).toBeTruthy();
        }
      });

      it('should have examples defined for all operations', () => {
        const ops = getAllSchemaOperations();
        for (const [_name, def] of Object.entries(ops)) {
          expect(def.examples).toBeDefined();
          expect(def.examples?.length).toBeGreaterThan(0);
        }
      });
    });
  });

  /**
   * Issue #594 - Introspection-only schemas
   */
  describe('Introspection-only schemas (Issue #594)', () => {
    describe('MEMORY_SCHEMAS', () => {
      it('should define 2 memory operations', () => {
        expect(Object.keys(MEMORY_SCHEMAS)).toHaveLength(2);
        expect(MEMORY_SCHEMAS.addEntry).toBeDefined();
        expect(MEMORY_SCHEMAS.clear).toBeDefined();
      });

      it('should use mcpAqlHandler for all', () => {
        for (const def of Object.values(MEMORY_SCHEMAS)) {
          expect(def.handler).toBe('mcpAqlHandler');
        }
      });

      it('should have correct endpoints', () => {
        expect(MEMORY_SCHEMAS.addEntry.endpoint).toBe('CREATE');
        expect(MEMORY_SCHEMAS.clear.endpoint).toBe('DELETE');
      });

      it('should define required params for addEntry', () => {
        expect(MEMORY_SCHEMAS.addEntry.params?.element_name?.required).toBe(true);
        expect(MEMORY_SCHEMAS.addEntry.params?.content?.required).toBe(true);
        expect(MEMORY_SCHEMAS.addEntry.params?.tags?.required).toBeUndefined();
        expect(MEMORY_SCHEMAS.addEntry.params?.metadata?.required).toBeUndefined();
      });

      it('should define required params for clear', () => {
        expect(MEMORY_SCHEMAS.clear.params?.element_name?.required).toBe(true);
      });
    });

    describe('EXECUTION_SCHEMAS', () => {
      it('should define 9 execution operations', () => {
        expect(Object.keys(EXECUTION_SCHEMAS)).toHaveLength(9);
      });

      it('should include all execution lifecycle operations', () => {
        const ops = Object.keys(EXECUTION_SCHEMAS);
        expect(ops).toContain('execute_agent');
        expect(ops).toContain('get_execution_state');
        expect(ops).toContain('record_execution_step');
        expect(ops).toContain('complete_execution');
        expect(ops).toContain('continue_execution');
        expect(ops).toContain('abort_execution');
        expect(ops).toContain('get_gathered_data');
        expect(ops).toContain('prepare_handoff');
        expect(ops).toContain('resume_from_handoff');
      });

      it('should use mcpAqlHandler for all', () => {
        for (const def of Object.values(EXECUTION_SCHEMAS)) {
          expect(def.handler).toBe('mcpAqlHandler');
        }
      });

      it('should define required params for execute_agent', () => {
        expect(EXECUTION_SCHEMAS.execute_agent.params?.element_name?.required).toBe(true);
        expect(EXECUTION_SCHEMAS.execute_agent.params?.parameters?.required).toBe(true);
        expect(EXECUTION_SCHEMAS.execute_agent.params?.maxAutonomousSteps?.required).toBeUndefined();
      });

      it('should document resilience policy in execute_agent description (issue #736)', () => {
        const desc = EXECUTION_SCHEMAS.execute_agent.description;
        expect(desc).toContain('resilience');
        expect(desc).toContain('onStepLimitReached');
        expect(desc).toContain('onExecutionFailure');
        expect(desc).toContain('maxRetries');
        expect(desc).toContain('maxContinuations');
      });

      it('should document activates lifecycle in execute_agent description (issue #736)', () => {
        const desc = EXECUTION_SCHEMAS.execute_agent.description;
        expect(desc).toContain('activates');
        expect(desc).toContain('automatically activated');
      });

      it('should document resilience interaction in maxAutonomousSteps param (issue #736)', () => {
        const paramDesc = EXECUTION_SCHEMAS.execute_agent.params?.maxAutonomousSteps?.description;
        expect(paramDesc).toContain('resilience');
        expect(paramDesc).toContain('onStepLimitReached');
      });

      it('should define required params for record_execution_step', () => {
        expect(EXECUTION_SCHEMAS.record_execution_step.params?.element_name?.required).toBe(true);
        expect(EXECUTION_SCHEMAS.record_execution_step.params?.stepDescription?.required).toBe(true);
        expect(EXECUTION_SCHEMAS.record_execution_step.params?.outcome?.required).toBe(true);
        expect(EXECUTION_SCHEMAS.record_execution_step.params?.findings?.required).toBeUndefined();
        expect(EXECUTION_SCHEMAS.record_execution_step.params?.nextActionHint?.required).toBeUndefined();
        expect(EXECUTION_SCHEMAS.record_execution_step.params?.riskScore?.required).toBeUndefined();
      });

      it('should define required params for complete_execution', () => {
        expect(EXECUTION_SCHEMAS.complete_execution.params?.element_name?.required).toBe(true);
        expect(EXECUTION_SCHEMAS.complete_execution.params?.outcome?.required).toBe(true);
        expect(EXECUTION_SCHEMAS.complete_execution.params?.summary?.required).toBe(true);
        expect(EXECUTION_SCHEMAS.complete_execution.params?.goalId?.required).toBeUndefined();
      });

      it('should define required params for handoff operations', () => {
        expect(EXECUTION_SCHEMAS.prepare_handoff.params?.element_name?.required).toBe(true);
        expect(EXECUTION_SCHEMAS.prepare_handoff.params?.goalId?.required).toBe(true);
        expect(EXECUTION_SCHEMAS.resume_from_handoff.params?.element_name?.required).toBe(true);
        expect(EXECUTION_SCHEMAS.resume_from_handoff.params?.handoffBlock?.required).toBe(true);
        expect(EXECUTION_SCHEMAS.resume_from_handoff.params?.parameters?.required).toBeUndefined();
      });
    });

    describe('GATEKEEPER_SCHEMAS', () => {
      it('should define 7 gatekeeper operations', () => {
        expect(Object.keys(GATEKEEPER_SCHEMAS)).toHaveLength(7);
        expect(GATEKEEPER_SCHEMAS.confirm_operation).toBeDefined();
        expect(GATEKEEPER_SCHEMAS.verify_challenge).toBeDefined();
        expect(GATEKEEPER_SCHEMAS.beetlejuice_beetlejuice_beetlejuice).toBeDefined();
        expect(GATEKEEPER_SCHEMAS.permission_prompt).toBeDefined();
        expect(GATEKEEPER_SCHEMAS.get_effective_cli_policies).toBeDefined();
        expect(GATEKEEPER_SCHEMAS.approve_cli_permission).toBeDefined();
        expect(GATEKEEPER_SCHEMAS.get_pending_cli_approvals).toBeDefined();
      });

      it('should have correct endpoints', () => {
        expect(GATEKEEPER_SCHEMAS.confirm_operation.endpoint).toBe('EXECUTE');
        expect(GATEKEEPER_SCHEMAS.verify_challenge.endpoint).toBe('CREATE');
        expect(GATEKEEPER_SCHEMAS.beetlejuice_beetlejuice_beetlejuice.endpoint).toBe('CREATE');
        // Issue #647: permission_prompt is a read-only policy evaluation
        expect(GATEKEEPER_SCHEMAS.permission_prompt.endpoint).toBe('READ');
      });

      it('should define required params for confirm_operation', () => {
        expect(GATEKEEPER_SCHEMAS.confirm_operation.params?.operation?.required).toBe(true);
        expect(GATEKEEPER_SCHEMAS.confirm_operation.params?.element_type?.required).toBeUndefined();
      });

      it('should define required params for verify_challenge', () => {
        expect(GATEKEEPER_SCHEMAS.verify_challenge.params?.challenge_id?.required).toBe(true);
        expect(GATEKEEPER_SCHEMAS.verify_challenge.params?.code?.required).toBe(true);
      });

      it('should have optional agent_name for beetlejuice', () => {
        expect(GATEKEEPER_SCHEMAS.beetlejuice_beetlejuice_beetlejuice.params?.agent_name?.required).toBeUndefined();
      });
    });

    describe('LOGGING_SCHEMAS', () => {
      it('should define 1 logging operation', () => {
        expect(Object.keys(LOGGING_SCHEMAS)).toHaveLength(1);
        expect(LOGGING_SCHEMAS.query_logs).toBeDefined();
      });

      it('should have all filter params as optional', () => {
        const params = LOGGING_SCHEMAS.query_logs.params!;
        for (const def of Object.values(params)) {
          expect(def.required).toBeUndefined();
        }
      });

      it('should include all documented filter fields', () => {
        const paramNames = Object.keys(LOGGING_SCHEMAS.query_logs.params!);
        expect(paramNames).toContain('category');
        expect(paramNames).toContain('level');
        expect(paramNames).toContain('source');
        expect(paramNames).toContain('message');
        expect(paramNames).toContain('since');
        expect(paramNames).toContain('until');
        expect(paramNames).toContain('limit');
        expect(paramNames).toContain('offset');
        expect(paramNames).toContain('correlationId');
      });
    });

    describe('ACTIVATION_SCHEMAS', () => {
      it('should define 3 activation operations', () => {
        expect(Object.keys(ACTIVATION_SCHEMAS)).toHaveLength(3);
        expect(ACTIVATION_SCHEMAS).toHaveProperty('activate_element');
        expect(ACTIVATION_SCHEMAS).toHaveProperty('deactivate_element');
        expect(ACTIVATION_SCHEMAS).toHaveProperty('get_active_elements');
      });

      it('should require element_name and element_type for activate_element', () => {
        const params = ACTIVATION_SCHEMAS.activate_element.params!;
        expect(params.element_name?.required).toBe(true);
        expect(params.element_type?.required).toBe(true);
      });

      it('should require element_name and element_type for deactivate_element', () => {
        const params = ACTIVATION_SCHEMAS.deactivate_element.params!;
        expect(params.element_name?.required).toBe(true);
        expect(params.element_type?.required).toBe(true);
      });

      it('should have optional element_type for get_active_elements', () => {
        const params = ACTIVATION_SCHEMAS.get_active_elements.params!;
        expect(params.element_type?.required).toBeUndefined();
      });

      it('should mention session persistence in activate_element description', () => {
        expect(ACTIVATION_SCHEMAS.activate_element.description).toContain('DOLLHOUSE_SESSION_ID');
      });

      it('should use READ endpoint for all activation operations', () => {
        for (const def of Object.values(ACTIVATION_SCHEMAS)) {
          expect(def.endpoint).toBe('READ');
        }
      });
    });

    describe('SEARCH_SCHEMAS', () => {
      it('should define 2 search operations', () => {
        expect(Object.keys(SEARCH_SCHEMAS)).toHaveLength(2);
        expect(SEARCH_SCHEMAS.search_elements).toBeDefined();
        expect(SEARCH_SCHEMAS.query_elements).toBeDefined();
      });

      it('should use mcpAqlHandler for all', () => {
        for (const def of Object.values(SEARCH_SCHEMAS)) {
          expect(def.handler).toBe('mcpAqlHandler');
        }
      });

      it('should have READ endpoints', () => {
        expect(SEARCH_SCHEMAS.search_elements.endpoint).toBe('READ');
        expect(SEARCH_SCHEMAS.query_elements.endpoint).toBe('READ');
      });

      it('should define required params for search_elements', () => {
        expect(SEARCH_SCHEMAS.search_elements.params?.query?.required).toBe(true);
        expect(SEARCH_SCHEMAS.search_elements.params?.element_type?.required).toBeUndefined();
      });

      it('should define required params for query_elements', () => {
        expect(SEARCH_SCHEMAS.query_elements.params?.element_type?.required).toBe(true);
      });

      it('should document aggregate group_by fields in query_elements (issue #631)', () => {
        const desc = SEARCH_SCHEMAS.query_elements.params?.aggregate?.description;
        expect(desc).toBeDefined();
        expect(desc).toContain('group_by');
        expect(desc).toContain('category');
        expect(desc).toContain('author');
        expect(desc).toContain('tags');
      });

      it('should include category aggregation examples in query_elements (issue #631)', () => {
        const examples = SEARCH_SCHEMAS.query_elements.examples;
        expect(examples).toBeDefined();
        expect(examples!.some(e => e.includes('group_by') && e.includes('category'))).toBe(true);
      });

      it('should document categories query in introspect operation (issue #631)', () => {
        const introspectSchema = INTROSPECTION_OPERATIONS.introspect;
        expect(introspectSchema.params?.query?.description).toContain('categories');
        expect(introspectSchema.examples).toBeDefined();
        expect(introspectSchema.examples!.some(e => e.includes('categories'))).toBe(true);
      });
    });

    describe('INTROSPECTION_ONLY_SCHEMAS aggregate', () => {
      it('should contain all introspection-only operations (sum of individual groups)', () => {
        const expectedCount =
          Object.keys(MEMORY_SCHEMAS).length +
          Object.keys(EXECUTION_SCHEMAS).length +
          Object.keys(GATEKEEPER_SCHEMAS).length +
          Object.keys(LOGGING_SCHEMAS).length +
          Object.keys(METRICS_SCHEMAS).length +
          Object.keys(ACTIVATION_SCHEMAS).length +
          Object.keys(SEARCH_SCHEMAS).length +
          Object.keys(BROWSER_SCHEMAS).length;
        expect(Object.keys(INTROSPECTION_ONLY_SCHEMAS)).toHaveLength(expectedCount);
      });

      it('should include memory, execution, gatekeeper, logging, activation, and search ops', () => {
        const ops = Object.keys(INTROSPECTION_ONLY_SCHEMAS);
        // Memory
        expect(ops).toContain('addEntry');
        expect(ops).toContain('clear');
        // Execution
        expect(ops).toContain('execute_agent');
        expect(ops).toContain('record_execution_step');
        // Gatekeeper
        expect(ops).toContain('confirm_operation');
        expect(ops).toContain('verify_challenge');
        // Logging
        expect(ops).toContain('query_logs');
        // Activation
        expect(ops).toContain('activate_element');
        expect(ops).toContain('deactivate_element');
        expect(ops).toContain('get_active_elements');
        // Search (Issue #595)
        expect(ops).toContain('search_elements');
        expect(ops).toContain('query_elements');
      });

      it('should NOT overlap with SCHEMA_DRIVEN_OPERATIONS', () => {
        const schemaKeys = new Set(Object.keys(SCHEMA_DRIVEN_OPERATIONS));
        for (const key of Object.keys(INTROSPECTION_ONLY_SCHEMAS)) {
          expect(schemaKeys.has(key)).toBe(false);
        }
      });
    });

    describe('ALL_OPERATION_SCHEMAS aggregate', () => {
      it('should be union of dispatch-driven and introspection-only', () => {
        const expectedCount = Object.keys(SCHEMA_DRIVEN_OPERATIONS).length +
          Object.keys(INTROSPECTION_ONLY_SCHEMAS).length;
        expect(Object.keys(ALL_OPERATION_SCHEMAS)).toHaveLength(expectedCount);
      });

      it('should have returns and examples for ALL operations', () => {
        for (const [_name, def] of Object.entries(ALL_OPERATION_SCHEMAS)) {
          expect(def.returns).toBeDefined();
          expect(def.returns?.name).toBeTruthy();
          expect(def.returns?.kind).toBeTruthy();
          expect(def.returns?.description).toBeTruthy();
          expect(def.examples).toBeDefined();
          expect(def.examples!.length).toBeGreaterThan(0);
        }
      });
    });

    describe('hasOperationSchema()', () => {
      it('should return true for schema-driven operations', () => {
        expect(hasOperationSchema('create_element')).toBe(true);
        expect(hasOperationSchema('browse_collection')).toBe(true);
      });

      it('should return true for introspection-only operations', () => {
        expect(hasOperationSchema('execute_agent')).toBe(true);
        expect(hasOperationSchema('addEntry')).toBe(true);
        expect(hasOperationSchema('confirm_operation')).toBe(true);
        expect(hasOperationSchema('query_logs')).toBe(true);
      });

      it('should return false for unknown operations', () => {
        expect(hasOperationSchema('nonexistent')).toBe(false);
      });
    });

    describe('getAnyOperationSchema()', () => {
      it('should return schema for dispatch-driven operations', () => {
        const schema = getAnyOperationSchema('create_element');
        expect(schema).toBeDefined();
        expect(schema?.handler).toBe('elementCRUD');
      });

      it('should return schema for introspection-only operations', () => {
        const schema = getAnyOperationSchema('execute_agent');
        expect(schema).toBeDefined();
        expect(schema?.handler).toBe('mcpAqlHandler');
        expect(schema?.returns?.name).toBe('ExecuteAgentResult');
      });

      it('should return undefined for unknown operations', () => {
        expect(getAnyOperationSchema('nonexistent')).toBeUndefined();
      });
    });

    describe('getAllOperationSchemas()', () => {
      it('should return more operations than getAllSchemaOperations()', () => {
        const all = getAllOperationSchemas();
        const schemaOnly = getAllSchemaOperations();
        expect(Object.keys(all).length).toBeGreaterThan(Object.keys(schemaOnly).length);
      });

      it('should include introspection-only operations', () => {
        const all = getAllOperationSchemas();
        expect(all.execute_agent).toBeDefined();
        expect(all.addEntry).toBeDefined();
        expect(all.confirm_operation).toBeDefined();
        expect(all.query_logs).toBeDefined();
      });
    });
  });
});
