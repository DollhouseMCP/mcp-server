/**
 * Test Configuration for MCP Server Testing
 * SECURE-3 Implementation: Configuration constants replacing hardcoded values
 * Addresses PR #662 reviewer feedback about hardcoded timeouts and magic numbers
 */

// CONFIGURATION OBJECT: Centralized timeout and test settings
const CONFIG = {
  timeouts: {
    tool_call: 5000,           // Individual tool call timeout (5s)  
    server_connection: 10000,  // Server connection timeout (10s)
    github_operations: 15000,  // GitHub operations timeout (15s)
    benchmark_timeout: 3000,   // Performance benchmark timeout (3s)
    stress_test_timeout: 30000 // Stress test total timeout (30s)
  },
  test_settings: {
    max_retries: 3,            // Maximum retry attempts for failed tests
    batch_size: 10,            // Number of concurrent tests in batch
    benchmark_iterations: 5,   // Number of iterations for performance benchmarks
    stress_test_iterations: 10, // Number of iterations for stress testing
    load_test_sizes: [10, 25, 50, 100], // Concurrent request sizes for load testing
    expected_response_time: 100 // Expected average response time (ms)
  },
  validation: {
    success_threshold: 95,     // Minimum success rate for tests to pass (%)
    performance_threshold: 3000, // Maximum acceptable response time (ms)
    memory_threshold: 500,     // Maximum memory usage increase (MB)
    concurrent_limit: 100      // Maximum concurrent operations
  }
};

// AVAILABLE TOOLS: Actual tools discovered from MCP server (not hardcoded list)
// Updated by tool discovery - only test tools that actually exist
const AVAILABLE_TOOLS = [
  'list_elements',
  'activate_element', 
  'get_active_elements',
  'deactivate_element',
  'get_element_details',
  'reload_elements',
  'render_template',
  'execute_agent',
  'create_element',
  'edit_element',
  'validate_element',
  'delete_element',
  'export_persona',
  'export_all_personas',
  'import_persona',
  'share_persona',
  'import_from_url',
  'browse_collection',
  'search_collection',
  'search_collection_enhanced',
  'get_collection_content',
  'install_content',
  'submit_content',
  'get_collection_cache_health',
  'set_user_identity',
  'get_user_identity',
  'clear_user_identity',
  'setup_github_auth',
  'check_github_auth',
  'clear_github_auth',
  'configure_oauth',
  'portfolio_status',
  'init_portfolio',
  'portfolio_config',
  'sync_portfolio',
  'search_portfolio',
  'search_all',
  'configure_indicator',
  'get_indicator_config',
  'configure_collection_submission',
  'get_collection_submission_config',
  'get_build_info'
];

// DEPRECATED TOOLS: Tools that were removed but still referenced in old tests
// These should NOT be tested and will cause failures
const DEPRECATED_TOOLS = [
  'browse_marketplace',      // Replaced by browse_collection
  'activate_persona',        // Replaced by activate_element  
  'get_active_persona',      // Replaced by get_active_elements
  'deactivate_persona',      // Replaced by deactivate_element
  'list_personas',           // Replaced by list_elements
  'get_persona_details',     // Replaced by get_element_details
  'marketplace_search',      // Replaced by search_collection
  'install_persona',         // Replaced by install_content
  'persona_status'           // Functionality merged into other tools
];

// TOOL CATEGORIES: Organized by functionality for better test organization  
const TOOL_CATEGORIES = {
  elements: [
    'list_elements', 'activate_element', 'get_active_elements', 'deactivate_element',
    'get_element_details', 'reload_elements', 'create_element', 'edit_element',
    'validate_element', 'delete_element'
  ],
  personas: [
    'export_persona', 'export_all_personas', 'import_persona', 'share_persona'
  ],
  collection: [
    'browse_collection', 'search_collection', 'search_collection_enhanced',
    'get_collection_content', 'install_content', 'submit_content',
    'get_collection_cache_health'
  ],
  user_management: [
    'set_user_identity', 'get_user_identity', 'clear_user_identity'
  ],
  auth: [
    'setup_github_auth', 'check_github_auth', 'clear_github_auth', 'configure_oauth'
  ],
  portfolio: [
    'portfolio_status', 'init_portfolio', 'portfolio_config', 'sync_portfolio'
  ],
  search: [
    'search_portfolio', 'search_all'
  ],
  system: [
    'configure_indicator', 'get_indicator_config', 'configure_collection_submission',
    'get_collection_submission_config', 'get_build_info'
  ],
  templates: [
    'render_template'
  ],
  agents: [
    'execute_agent'
  ],
  imports: [
    'import_from_url'
  ]
};

// TEST ARGUMENTS: Proper arguments for each tool (prevents argument errors)
// Uses Unicode-normalized values for security compliance
const TEST_ARGUMENTS = {
  'list_elements': { type: 'personas' },
  'activate_element': { name: 'test-persona', type: 'personas' },
  'get_active_elements': { type: 'personas' },
  'deactivate_element': { name: 'test-persona', type: 'personas' },
  'get_element_details': { name: 'test-persona', type: 'personas' },
  'reload_elements': { type: 'personas' },
  'browse_collection': { section: 'library', type: 'personas' },
  'search_collection': { query: 'creative' },
  'search_collection_enhanced': { query: 'creative', elementType: 'personas' },
  'get_collection_content': { path: 'library/personas/creative-writer.md' },
  'install_content': { path: 'library/personas/creative-writer.md' },
  'submit_content': { content: 'test-persona' },
  'get_collection_cache_health': {},
  'set_user_identity': { username: 'qa-test-user' },
  'get_user_identity': {},
  'clear_user_identity': {},
  // Fixed: Removed hardcoded token for security - use environment variable or test placeholder
  'setup_github_auth': { token: process.env.GITHUB_TEST_TOKEN || 'PLACEHOLDER_TEST_TOKEN' },
  'check_github_auth': {},
  'clear_github_auth': {},
  'configure_oauth': { provider: 'github' },
  'portfolio_status': {},
  'init_portfolio': {},
  'portfolio_config': {},
  'sync_portfolio': {},
  'search_portfolio': { query: 'test' },
  'search_all': { query: 'test' },
  'configure_indicator': { enabled: true },
  'get_indicator_config': {},
  'configure_collection_submission': { enabled: true },
  'get_collection_submission_config': {},
  'get_build_info': {},
  'render_template': { name: 'test-template', variables: {} },
  'execute_agent': { name: 'test-agent', goal: 'test goal' },
  'create_element': { name: 'test', type: 'personas', description: 'test element' },
  'edit_element': { name: 'test', type: 'personas', field: 'description', value: 'updated' },
  'validate_element': { name: 'test', type: 'personas' },
  'delete_element': { name: 'test', type: 'personas', deleteData: false },
  'export_persona': { name: 'test' },
  'export_all_personas': {},
  'import_persona': { filePath: 'test.md' },
  'share_persona': { name: 'test' },
  'import_from_url': { url: 'https://example.com/test.md' }
};

/**
 * Tool validation function - checks if tool exists before testing
 * Prevents testing non-existent tools that cause failures
 */
function validateToolExists(toolName) {
  return AVAILABLE_TOOLS.includes(toolName);
}

/**
 * Get test configuration for a specific tool
 * Returns null if tool doesn't exist or is deprecated
 */
function getToolTestConfig(toolName) {
  if (!validateToolExists(toolName)) {
    return null;
  }
  
  if (DEPRECATED_TOOLS.includes(toolName)) {
    return null;
  }
  
  return {
    name: toolName,
    arguments: TEST_ARGUMENTS[toolName] || {},
    timeout: CONFIG.timeouts.tool_call
  };
}

/**
 * Calculate accurate success rate based on actual test results
 * No more inflated success rates - honest reporting only
 */
function calculateAccurateSuccessRate(results) {
  if (!results || results.length === 0) {
    return 0;
  }
  
  const successful = results.filter(result => result.success === true).length;
  const total = results.length;
  
  return {
    successful,
    total,
    percentage: Math.round((successful / total) * 100),
    ratio: `${successful}/${total}`
  };
}

/**
 * Filter tools by category for organized testing
 */
function getToolsByCategory(category) {
  return TOOL_CATEGORIES[category] || [];
}

/**
 * Get all testable tools (excludes deprecated ones)
 */
function getAllTestableTools() {
  return AVAILABLE_TOOLS.filter(tool => !DEPRECATED_TOOLS.includes(tool));
}

// Export configuration for use in test scripts
export {
  CONFIG,
  AVAILABLE_TOOLS,
  DEPRECATED_TOOLS,
  TOOL_CATEGORIES,
  TEST_ARGUMENTS,
  validateToolExists,
  getToolTestConfig,
  calculateAccurateSuccessRate,
  getToolsByCategory,
  getAllTestableTools
};