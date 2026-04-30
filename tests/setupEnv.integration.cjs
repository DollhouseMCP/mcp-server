// Integration test environment setup.
// Runs in each Jest worker BEFORE the test files are required, so env vars
// set here are visible to module-level config evaluation (e.g. src/config/env.ts).
//
// LOG_LEVEL=debug ensures the [MCP-AQL] READ debug log entries reach the
// MemoryLogSink. HTTP transport session-attribution tests rely on these
// entries being persisted so query_logs can read them back. Default
// LOG_LEVEL=info drops debug entries before they reach the sink.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'debug';

// DOLLHOUSE_USER establishes operator identity for DB-backed integration
// tests. Without it, MCP-AQL operations in DB mode fail the identity check
// added in #1886 (checkHttpIdentity / UserContext.ts) and return
// "No user identity set". Normally set in the developer's .env.local or
// shell; provide a deterministic default for clean test environments.
process.env.DOLLHOUSE_USER = process.env.DOLLHOUSE_USER || 'integration-test-user';
