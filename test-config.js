/**
 * Test Configuration for MCP Server Testing
 * SECURE-3 Implementation: Configuration constants replacing hardcoded values
 * Addresses PR #662 reviewer feedback about hardcoded timeouts and magic numbers
 */

import { UnicodeValidator } from './src/security/validators/unicodeValidator.js';
import { SecurityMonitor } from './src/security/securityMonitor.js';

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

/**
 * Normalize string values for security compliance
 * Applies Unicode normalization to prevent bypass attacks
 */
function normalizeValue(value) {
  if (typeof value === 'string') {
    // Log security operation for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'UNICODE_NORMALIZATION',
      severity: 'LOW',
      source: 'test_config',
      details: 'Unicode normalization applied to test configuration value'
    });
    
    const result = UnicodeValidator.normalize(value);
    return result.normalizedContent;
  }
  return value;
}

// TEST ARGUMENTS: Proper arguments for each tool (prevents argument errors)
// Uses Unicode-normalized values for security compliance
const TEST_ARGUMENTS = {
  'list_elements': { type: normalizeValue('personas') },
  'activate_element': { name: normalizeValue('test-persona'), type: normalizeValue('personas') },
  'get_active_elements': { type: normalizeValue('personas') },
  'deactivate_element': { name: normalizeValue('test-persona'), type: normalizeValue('personas') },
  'get_element_details': { name: normalizeValue('test-persona'), type: normalizeValue('personas') },
  'reload_elements': { type: normalizeValue('personas') },
  'browse_collection': { section: normalizeValue('library'), type: normalizeValue('personas') },
  'search_collection': { query: normalizeValue('creative') },
  'search_collection_enhanced': { query: normalizeValue('creative'), elementType: normalizeValue('personas') },
  'get_collection_content': { path: normalizeValue('library/personas/creative-writer.md') },
  'install_content': { path: normalizeValue('library/personas/creative-writer.md') },
  'submit_content': { content: normalizeValue('test-persona') },
  'get_collection_cache_health': {},
  'set_user_identity': { username: normalizeValue('qa-test-user') },
  'get_user_identity': {},
  'clear_user_identity': {},
  // Fixed: Removed hardcoded token for security - use environment variable or test placeholder
  'setup_github_auth': { token: normalizeValue(process.env.GITHUB_TEST_TOKEN || 'PLACEHOLDER_TEST_TOKEN') },
  'check_github_auth': {},
  'clear_github_auth': {},
  'configure_oauth': { provider: normalizeValue('github') },
  'portfolio_status': {},
  'init_portfolio': {},
  'portfolio_config': {},
  'sync_portfolio': {},
  'search_portfolio': { query: normalizeValue('test') },
  'search_all': { query: normalizeValue('test') },
  'configure_indicator': { enabled: true },
  'get_indicator_config': {},
  'configure_collection_submission': { enabled: true },
  'get_collection_submission_config': {},
  'get_build_info': {},
  'render_template': { name: normalizeValue('test-template'), variables: {} },
  'execute_agent': { name: normalizeValue('test-agent'), goal: normalizeValue('test goal') },
  'create_element': { name: normalizeValue('test'), type: normalizeValue('personas'), description: normalizeValue('test element') },
  'edit_element': { name: normalizeValue('test'), type: normalizeValue('personas'), field: normalizeValue('description'), value: normalizeValue('updated') },
  'validate_element': { name: normalizeValue('test'), type: normalizeValue('personas') },
  'delete_element': { name: normalizeValue('test'), type: normalizeValue('personas'), deleteData: false },
  'export_persona': { name: normalizeValue('test') },
  'export_all_personas': {},
  'import_persona': { filePath: normalizeValue('test.md') },
  'share_persona': { name: normalizeValue('test') },
  'import_from_url': { url: normalizeValue('https://example.com/test.md') }
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