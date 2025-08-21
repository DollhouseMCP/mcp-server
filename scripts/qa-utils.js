/**
 * Shared QA Utilities for DollhouseMCP Testing
 * 
 * Common functions used across all QA testing scripts to eliminate
 * code duplication and ensure consistent behavior.
 */

import fetch from 'node-fetch';

/**
 * Discovers available MCP tools via the Inspector API
 * @param {string} inspectorUrl - The Inspector API URL
 * @param {string} sessionToken - Authentication token
 * @returns {Promise<string[]>} Array of available tool names
 */
export async function discoverAvailableTools(inspectorUrl, sessionToken) {
  try {
    console.log('📋 Discovering available tools via Inspector API...');
    const response = await fetch(inspectorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`
      },
      body: JSON.stringify({
        method: 'tools/list'
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    const availableTools = result.result?.tools?.map(t => t.name) || [];
    console.log(`📋 Discovered ${availableTools.length} available tools`);
    
    // Enhanced error logging when no tools are discovered
    if (availableTools.length === 0) {
      console.warn('⚠️  No tools discovered - all tests will be skipped');
      console.warn('   Check if the MCP server is running correctly');
      console.warn('   Verify the Inspector API endpoint is accessible');
    }
    
    return availableTools;
  } catch (error) {
    console.error('⚠️  Failed to discover tools:', error.message);
    console.warn('⚠️  No tools discovered - all tests will be skipped');
    return [];
  }
}

/**
 * Discovers available MCP tools via direct SDK connection
 * @param {Client} client - MCP SDK client instance
 * @returns {Promise<string[]>} Array of available tool names
 */
export async function discoverAvailableToolsDirect(client) {
  try {
    console.log('📋 Discovering available tools via direct connection...');
    const result = await client.listTools();
    const availableTools = result.tools.map(t => t.name);
    console.log(`📋 Discovered ${availableTools.length} available tools`);
    
    // Enhanced error logging when no tools are discovered
    if (availableTools.length === 0) {
      console.warn('⚠️  No tools discovered - all tests will be skipped');
      console.warn('   Check if the MCP server is running correctly');
      console.warn('   Verify the SDK connection is established');
    }
    
    return availableTools;
  } catch (error) {
    console.error('⚠️  Failed to discover tools:', error.message);
    console.warn('⚠️  No tools discovered - all tests will be skipped');
    return [];
  }
}

/**
 * Validates if a tool exists in the available tools list
 * @param {string} toolName - Name of the tool to validate
 * @param {string[]} availableTools - Array of available tool names
 * @returns {boolean} True if tool exists and is available
 */
export function validateToolExists(toolName, availableTools) {
  // Always return true if no tools were discovered (to allow fallback behavior)
  if (availableTools.length === 0) {
    return true;
  }
  
  if (!availableTools.includes(toolName)) {
    console.log(`  ⚠️  Skipping ${toolName} - tool not available`);
    return false;
  }
  return true;
}

/**
 * Calculates accurate success rate statistics from test results
 * @param {Array} results - Array of test results
 * @returns {Object} Statistics object with success rate data
 */
export function calculateAccurateSuccessRate(results) {
  // Filter out skipped tests
  const executed = results.filter(r => !r.skipped);
  const successful = executed.filter(r => r.success).length;
  const total = executed.length;
  const skipped = results.filter(r => r.skipped).length;
  
  return {
    successful,
    total,
    skipped,
    percentage: total > 0 ? Math.round((successful / total) * 100) : 0
  };
}

/**
 * Creates a standardized test result object
 * @param {string} toolName - Name of the tool being tested
 * @param {Object} params - Parameters passed to the tool
 * @param {number} startTime - Test start timestamp
 * @param {boolean} success - Whether the test succeeded
 * @param {Object} result - Test result data (optional)
 * @param {string} error - Error message (optional)
 * @param {boolean} skipped - Whether the test was skipped (optional)
 * @returns {Object} Standardized test result object
 */
export function createTestResult(toolName, params, startTime, success, result = null, error = null, skipped = false) {
  return {
    success,
    tool: toolName,
    params,
    result,
    error,
    skipped,
    duration: Date.now() - startTime
  };
}

/**
 * Logs test results in a consistent format
 * @param {string} testName - Name of the test
 * @param {Object} result - Test result object
 */
export function logTestResult(testName, result) {
  if (result.skipped) {
    console.log(`  ⚠️  ${testName}: Skipped - ${result.error} (${result.duration}ms)`);
  } else if (result.success) {
    console.log(`  ✅ ${testName}: Success (${result.duration}ms)`);
  } else {
    console.log(`  ❌ ${testName}: ${result.error} (${result.duration}ms)`);
  }
}

/**
 * Generates a standardized test report summary
 * @param {Array} results - Array of test results
 * @param {string[]} availableTools - Array of available tool names
 * @param {Date} startTime - Test suite start time
 * @returns {Object} Standardized report object
 */
export function generateTestReport(results, availableTools, startTime) {
  const endTime = new Date();
  const duration = endTime - startTime;
  const stats = calculateAccurateSuccessRate(results);
  const totalTests = results.length;
  
  return {
    timestamp: endTime.toISOString(),
    duration: `${duration}ms`,
    tool_discovery: {
      available_tools_count: availableTools.length,
      available_tools: availableTools
    },
    summary: {
      total_tests: totalTests,
      executed_tests: stats.total,
      skipped_tests: stats.skipped,
      successful_tests: stats.successful,
      failed_tests: stats.total - stats.successful,
      success_rate: `${stats.percentage}%`,
      success_rate_note: "Based only on executed tests (excludes skipped)"
    },
    results: results.map(r => ({
      tool: r.tool,
      success: r.success,
      skipped: r.skipped || false,
      params: r.params,
      error: r.error || null,
      duration: r.duration
    }))
  };
}