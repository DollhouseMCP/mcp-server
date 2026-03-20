// Jest setup file for global test configuration

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PERSONAS_DIR = 'test-personas';

// Use discrete mode for tests - integration tests use individual tools like activate_element
// Production default is 'mcpaql' but tests need discrete tools to be registered
process.env.MCP_INTERFACE_MODE = 'discrete';