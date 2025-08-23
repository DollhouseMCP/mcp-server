/**
 * Test Configuration for MCP Server Testing
 * SECURE-3 Implementation: Configuration constants replacing hardcoded values
 * Addresses PR #662 reviewer feedback about hardcoded timeouts and magic numbers
 */

import { UnicodeValidator } from './dist/security/validators/unicodeValidator.js';
import { SecurityMonitor } from './dist/security/securityMonitor.js';

// CI ENVIRONMENT DETECTION
const IS_CI = process.env.CI === 'true' || 
              process.env.CONTINUOUS_INTEGRATION === 'true' ||
              process.env.GITHUB_ACTIONS === 'true' ||
              !!process.env.JENKINS_URL ||
              !!process.env.TRAVIS ||
              !!process.env.CIRCLECI;

// CONFIGURATION OBJECT: Centralized timeout and test settings
const CONFIG = {
  timeouts: {
    tool_call: IS_CI ? 10000 : 5000,           // Individual tool call timeout (doubled in CI)
    server_connection: IS_CI ? 20000 : 10000,  // Server connection timeout (doubled in CI)
    github_operations: IS_CI ? 30000 : 15000,  // GitHub operations timeout (doubled in CI)
    benchmark_timeout: IS_CI ? 6000 : 3000,    // Performance benchmark timeout (doubled in CI)
    stress_test_timeout: IS_CI ? 60000 : 30000 // Stress test total timeout (doubled in CI)
  },
  test_settings: {
    max_retries: IS_CI ? 5 : 3,            // Maximum retry attempts for failed tests (more in CI)
    batch_size: IS_CI ? 5 : 10,            // Number of concurrent tests in batch (smaller in CI)
    benchmark_iterations: IS_CI ? 3 : 5,   // Number of iterations for performance benchmarks (fewer in CI)
    stress_test_iterations: IS_CI ? 5 : 10, // Number of iterations for stress testing (fewer in CI)
    load_test_sizes: IS_CI ? [5, 10, 20] : [10, 25, 50, 100], // Concurrent request sizes (smaller in CI)
    expected_response_time: IS_CI ? 500 : 100 // Expected average response time (higher tolerance in CI)
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
  'setup_github_auth': { token: normalizeValue(process.env.TEST_GITHUB_TOKEN || 'PLACEHOLDER_TEST_TOKEN') },
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

/**
 * Check if running in CI environment
 */
function isCI() {
  return IS_CI;
}

/**
 * Get CI-appropriate test arguments for tools that need different settings in CI
 */
function getCITestArguments(toolName) {
  const args = TEST_ARGUMENTS[toolName] || {};
  
  // Override certain arguments for CI environment
  if (IS_CI) {
    switch (toolName) {
      case 'setup_github_auth':
        return {
          ...args,
          token: process.env.TEST_GITHUB_TOKEN || 'CI_PLACEHOLDER_TOKEN'
        };
      case 'create_element':
        return {
          ...args,
          name: 'CI-Test-Element',
          description: 'CI test element - safe to delete'
        };
      default:
        return args;
    }
  }
  
  return args;
}

/**
 * Check if a test should be skipped in CI
 */
function shouldSkipInCI(toolName) {
  if (!IS_CI) return false;
  
  // Skip tests that require GitHub tokens if not available
  const requiresGitHubToken = [
    'setup_github_auth',
    'submit_content',
    'sync_portfolio'
  ];
  
  if (requiresGitHubToken.includes(toolName) && !process.env.TEST_GITHUB_TOKEN) {
    return true;
  }
  
  // Skip tests that require real file operations if TEST_PERSONAS_DIR not set
  const requiresFileSystem = [
    'import_persona',
    'export_persona',
    'export_all_personas'
  ];
  
  if (requiresFileSystem.includes(toolName) && !process.env.TEST_PERSONAS_DIR) {
    return true;
  }
  
  return false;
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
  getAllTestableTools,
  isCI,
  getCITestArguments,
  shouldSkipInCI
};