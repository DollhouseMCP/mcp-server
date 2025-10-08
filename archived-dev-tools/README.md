# Archived Development Tools

This directory contains one-time QA automation, performance testing, and diagnostic tools created in August 2025. These tools contain **valuable patterns** that are being extracted and consolidated into modern, version-agnostic performance and diagnostic tools.

## Structure

### test-scripts/
- Various test scripts and utilities used during development
- QA validation scripts
- Test configuration files
- Test results and outputs
- Test data directories

### debug-scripts/
- Debug utilities and diagnostic scripts
- Tools for troubleshooting MCP issues
- Performance debugging scripts

### performance-analysis/
- Performance benchmarking scripts
- Performance testing utilities

## Extraction Work In Progress

These tools contain many valuable patterns for performance testing, diagnostics, and tool validation that are being consolidated into:

- **Issue #1280**: Performance testing framework → `test/performance/`
  - Response time benchmarking
  - Load testing and concurrency validation
  - Performance degradation detection

- **Issue #1281**: Modern diagnostic suite → `scripts/diagnose.js`
  - Version-agnostic installation validation
  - Portfolio structure checking
  - Server health diagnostics

- **Issue #1282**: Tool metadata and helpers → `src/tools/metadata.ts` + `test/helpers/tool-utils.ts`
  - Tool categorization (11 categories, 41 tools)
  - Reusable test utilities
  - Deprecated tools tracking

**Status**: These specific scripts are not actively maintained but serve as reference for the pattern extraction work above.

**After extraction**: Issue #1283 will clean up this directory once all valuable patterns have been moved to their modern, maintainable locations.
