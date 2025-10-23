# Changelog

## [Unreleased]

## [1.9.21] - 2025-10-23

**Patch Release**: Memory validation system activation

### Fixed
- **Background memory validation startup** (#1389)
  - BackgroundValidator service now starts automatically on server initialization
  - Memory entries with UNTRUSTED status will be automatically validated every 5 minutes
  - Trust levels are now properly updated (VALIDATED, FLAGGED, QUARANTINED)
  - Validation runs server-side with zero token cost

### Context
The BackgroundValidator service was fully implemented in Issue #1314 (Phase 1: Background validation for memory security) but was never activated. The `backgroundValidator.start()` method was missing from server initialization, causing all memories to remain UNTRUSTED indefinitely.

This patch release adds proper lifecycle management:
- Import backgroundValidator singleton in server initialization
- Start validation service after resource handlers are set up
- Stop service during server cleanup

### Impact
- Memory security architecture is now fully operational
- UNTRUSTED memories will be automatically validated
- Trust level updates work correctly
- No performance impact (runs in background outside LLM context)

## [1.9.20] - 2025-10-17

**Fix Release**: MCP Registry Publishing Compatibility

### Fixed
- MCP Registry publishing case sensitivity issue (#XXXX)
  - Corrected `mcpName` field in package.json to match GitHub organization capitalization
  - Changed from `io.github.dollhousemcp/mcp-server` to `io.github.DollhouseMCP/mcp-server`
  - Resolves NPM package validation errors when publishing to MCP Registry
  - Ensures proper namespace permission matching

### Context
The MCP Registry performs two case-sensitive validations:
1. Permission check against GitHub org name (`io.github.DollhouseMCP/*`)
2. NPM package validation against `mcpName` field in package.json

The initial implementation incorrectly used lowercase for `mcpName`, causing a validation mismatch. This patch release corrects the capitalization to match our GitHub organization name.

## [1.9.19] - 2025-10-17

**Comprehensive Release**: 90 commits including security fixes, PostHog telemetry, MCP registry support, and major cleanup

### Added
- MCP registry publishing workflow with OIDC authentication (#1367)
  - Automated publishing to registry.modelcontextprotocol.io
  - GitHub Actions workflow with manual dry-run mode
  - Comprehensive test suite for workflow validation (50+ tests)
  - Pinned mcp-publisher CLI to v1.3.3 for reproducibility
- PostHog remote telemetry integration (#1357, #1361)
  - Opt-in remote analytics with DOLLHOUSE_TELEMETRY_OPTIN=true
  - Usage patterns and error tracking
  - Privacy-focused with explicit consent
- MCP Resources support for capability index (#1360)
  - Future-proof architecture (disabled by default)
  - Ready for MCP protocol evolution
- Dual licensing model with commercial option (#1350)
  - AGPL-3.0 with platform stability commitments
  - Commercial licensing pathway
- Minimal installation telemetry (#1359)
  - Operational metrics for v1.9.19
  - Installation success tracking
- Security telemetry tracking for blocked attacks (#1313)
- Automated release issue verification system (#1249)
- Orphaned issues checker for systematic cleanup (#1251)
- Personal development notes directory (#1275)

### Security
- Phase 1: Background validation for memory security (#1316, #1320, #1322)
- Phase 2: AES-256-GCM pattern encryption (#1323)
- Fixed symlink path traversal vulnerability (#1290, #1306)
  - Resolve symlinks before validation
  - Enhanced audit logging
  - Comprehensive path sanitization
- Fixed command injection in verify-release-issues.js (#1249)
  - DMCP-SEC-001: Critical vulnerability patched
  - PATH injection protection with absolute paths
- Tightened YAML bomb detection threshold from 10:1 to 5:1 (#1305)
- Fixed multiple security audit issues (3 MEDIUM/LOW severity)

### Fixed
- Missing shell: bash declarations in MCP registry workflow
- OAuth device flow zero-scopes bug (using OIDC instead)
- Test isolation to prevent resource contention (#1288)
- GitHub rate limiter test failures (#1285)
- Recognition of MERGED state in release verification (#1250)
- Resolved 26+ SonarCloud code quality issues across multiple files
  - Import/export ordering issues
  - Cognitive complexity reductions
  - Security hotspot resolutions
- Cross-platform workflow compatibility improvements
- Namespace casing for MCP registry (DollhouseMCP)

### Changed
- Improved whitespace detection performance
- Enhanced path traversal protection mechanisms
- Skip Claude Code Review for Dependabot PRs (#1241)
- Refactored CLAUDE.md into modular documentation (#1270)
- Renamed docs/archive/ to docs/session-history/ (#1277)
- Added node: prefix for built-in module imports
- Reduced cognitive complexity in multiple modules

### Dependencies
- Updated @modelcontextprotocol/sdk from 1.18.0 to 1.20.0
- Updated jest from 30.0.5 to 30.2.0
- Updated @types/node from 24.4.0 to 24.7.0
- Updated typescript from 5.9.2 to 5.9.3
- Updated multiple dev dependencies
- Added PostHog SDK for telemetry

### Technical
- OIDC permissions: id-token:write, contents:read
- server.json included in NPM package
- Docker build optimizations and multi-platform support
- Auto-sync README files on develop push
- Enhanced test coverage and reliability
- Improved CI/CD pipeline stability

## [1.9.18] - 2025-10-17

**Feature Release**: PostHog remote telemetry (opt-in), MCP Resources support, and operational telemetry foundation

### Added

- **PostHog Remote Telemetry Integration** (#1357, #1361) - Opt-in remote analytics
  - **Simple opt-in**: Set `DOLLHOUSE_TELEMETRY_OPTIN=true` to enable remote telemetry
  - Uses shared PostHog project for community-wide insights
  - Default PostHog project key embedded (safe to expose - write-only)
  - Backward compatible with custom `POSTHOG_API_KEY` for enterprise deployments
  - Multiple control levels:
    - `DOLLHOUSE_TELEMETRY_OPTIN=true` - Enable remote telemetry
    - `DOLLHOUSE_TELEMETRY_NO_REMOTE=true` - Local only, no PostHog
    - `DOLLHOUSE_TELEMETRY=false` - Disable all telemetry
  - GDPR compliant - fully opt-in by design
  - See [docs/privacy/OPERATIONAL_TELEMETRY.md](docs/privacy/OPERATIONAL_TELEMETRY.md) for complete privacy policy
  - Future incentive program planned for community contributors

- **MCP Resources Support** (#1360) - Future-proof implementation of MCP Resources protocol
  - Three resource variants exposed: summary (~3K tokens), full (~40K tokens), and stats (JSON)
  - Capability index exposed as MCP resources for intelligent element discovery
  - **Status**: Non-functional in Claude Code (Oct 2025) - discovery only, not read
  - **Default**: Disabled for safety - zero overhead when not enabled
  - Manual attachment works in Claude Desktop and VS Code
  - Comprehensive user documentation at `docs/configuration/MCP_RESOURCES.md`
  - Research document at `docs/development/MCP_RESOURCES_SUPPORT_RESEARCH_2025-10-16.md`
  - Configuration options: `resources.enabled`, `resources.expose[]`, `resources.cache_ttl`
  - Early adopter advantage - ready when MCP clients implement full resource reading

- **Operational Telemetry Foundation** (#1358, #1359) - Minimal installation tracking
  - Tracks single installation event on first run (version, OS, Node version, MCP client)
  - Local-only logging to `~/.dollhouse/telemetry.log` by default
  - Simple opt-out via `DOLLHOUSE_TELEMETRY=false` environment variable
  - Privacy-first design: no PII, no behavioral data, no user content
  - Anonymous UUID generated locally for installation identification
  - Graceful error handling (never crashes if files can't be written)
  - Zero performance impact when opted out

### Documentation

- Added comprehensive telemetry incentive strategy guide
- Updated privacy policy with PostHog opt-in details
- Added session notes for telemetry implementation
- Enhanced README with telemetry opt-in section

### Test Results

- 2546 tests passing
- Test coverage: >96% maintained
- All CI checks passing across all platforms

## [1.9.17] - 2025-10-08

Test isolation and repository cleanup patch

### Fixed
- **Performance Test Isolation (#1288)**: Fixed flaky IndexOptimization test by isolating performance tests
  - Created dedicated `jest.performance.config.cjs` with 4 parallel workers
  - Main test suite no longer runs performance tests concurrently (prevents resource contention)
  - IndexOptimization test now consistently passes at 60-70ms (was failing at 926ms due to interference)
  - Added `test:performance` and `test:all` npm scripts
  - CI workflows updated with dedicated performance test step
  - Execution time: 18.7s with 4 workers vs 10+ minutes serial
  - Reduced code duplication by using filter to inherit base config patterns

- **Repository Cleanup (#1287)**: Removed ignored files from Git tracking
  - Removed `.obsidian/` directory (4 files) and `test-results/` (3 files) from version control
  - Files remain available locally but no longer tracked in repository
  - Follows gitignore additions from PR #1276

- **Flaky Test Management (#1286)**: Skip flaky GitHubRateLimiter tests
  - Marked intermittent GitHub API rate limiter tests as skipped
  - Prevents CI failures from external API dependencies
  - Tests can be run manually when needed

### Chores
- **Repository Organization (#1276)**: Added `.obsidian/` and `test-results/` to .gitignore
- **Documentation Structure (#1277)**: Renamed docs/archive/ to docs/session-history/
- **Docker Best Practices (#1273)**: Enhanced Docker environment file documentation
- **Data Directory Documentation (#1274)**: Added README to data/ directory
- **Documentation Refactor (#1270)**: Improved CLAUDE.md organization and clarity

### Features
- **Issue Management (#1251)**: Added orphaned issues checker for repository maintenance
- **Developer Experience (#1275)**: Added dev-notes/ directory for personal documentation
- **CI Improvements**: Added automated release issue verification (#1241)
- **Dependabot Integration (#1241)**: Skip Claude Code Review for Dependabot PRs

### Test Results
- Main suite: 2269 tests passing (performance tests excluded)
- Performance suite: 62 tests passing (isolated execution)
- Total: 2331 tests passing
- No flaky tests remaining
- CI/CD: All workflows passing across all platforms

## [1.9.15] - 2025-10-01

Security patch: Zero-width Unicode bypass vulnerability + SonarCloud cleanup

SECURITY FIX [HIGH]:
- Block zero-width Unicode characters in metadata validation (#1228, #1229)
- Prevents steganography and homograph attacks

CODE QUALITY:
- 228+ SonarCloud issues resolved (#1220-1224)
- 199 security hotspots evaluated (all safe)
- Number.parseInt modernization, String.replaceAll updates

All production security concerns resolved.

## [1.9.14] - 2025-09-30

### Fixed
- **ElementFormatter Security Scanner False Positives (Issue #1211, PR #1212)**
  - Fixed SecureYamlParser ignoring `validateContent: false` option
  - Pre-parse security validation now properly respects validation flag
  - ElementFormatter now uses `validateContent: false` for all YAML parsing (5 locations)
  - Allows local trusted files to bypass content scanning while maintaining security for untrusted sources
  - Improved memory name generation: derives names from filenames instead of auto-generated IDs
  - Example: `sonarcloud-rules-reference` instead of `mem_1759077319164_w9m9fk56y`

- **Portfolio Search File Extension Display (Issue #1213, PR #1215)**
  - Portfolio search now displays correct file extensions based on element type
  - Memories show `.yaml` extension, other elements show `.md` extension
  - Added `getFileExtension()` public method to PortfolioManager
  - Fixed hardcoded `.md` extension in search result formatting
  - No breaking changes, display-only fix

### Code Quality
- Fixed SonarCloud issues in Docker test files:
  - S7018: Sorted apt packages alphabetically in Dockerfile.test-enhanced
  - S7031: Merged consecutive RUN instructions in Dockerfile.test-enhanced
  - S7772: Added `node:` prefix for built-in module imports (4 occurrences)
  - S2486: Added proper error logging for JSON parse exceptions
  - S7780: Used String.raw for grep regex patterns (2 occurrences)
- Added comprehensive test coverage for portfolio search file extensions
- 2,277 tests passing with >96% coverage

### Documentation
- Added SESSION_NOTES_2025-09-30-AFTERNOON-PR1215-SONARCLOUD-PROCEDURE.md
- Added SONARCLOUD_QUERY_PROCEDURE.md - Critical guide for querying SonarCloud correctly
- Updated CLAUDE.md with naming conventions and style guide for session notes and memories

## [1.9.13] - 2025-09-29

### Fixed
- **Memory System Critical Fixes (Issue #1206, PR #1207)**
  - Fixed security scanner false positives preventing legitimate security documentation from loading
  - Memory files with security terms (vulnerability, exploit, attack) now load correctly
  - Local memory files are now pre-trusted (validateContent: false)

  - Added visible error reporting for failed memory loads
  - Users now see "Failed to load X memories" with detailed error messages
  - New getLoadStatus() diagnostic method for troubleshooting

  - New legacy memory migration tool (migrate-legacy-memories.ts)
  - Migrates old .md files to .yaml format in date-organized folders
  - Safe archiving of original files, dry-run mode by default

### Added
- **CLI Utility**: migrate-legacy-memories.ts for legacy file migration
- **Diagnostic Method**: getLoadStatus() for memory loading diagnostics
- **Error Tracking**: failedLoads tracking in MemoryManager

### Code Quality
- Fixed SonarCloud S3776: Reduced cognitive complexity in getLoadStatus()
- Fixed SonarCloud S3358: Replaced nested ternary with if-else chain
- Fixed SonarCloud S7785: Use top-level await instead of promise chain
- Extracted handleLoadFailure() to eliminate code duplication
- Use os.homedir() for cross-platform reliability

### Security
- Fixed DMCP-SEC-004: Added Unicode normalization to CLI input validation

## [1.9.12] - 2025-09-29

### Fixed
- **Memory System Critical Fixes**
  - Fixed PortfolioIndexManager overwriting memory metadata during indexing (Issue #1196, PR #1197)
  - Memory descriptions now properly preserved instead of being replaced with "Memory element"
  - Fixed memory portfolio index test isolation (Issue #1194, PR #1195)
  - Tests now use temporary directories instead of contaminating real user portfolio
  - Added security validation for memory YAML parsing (size limits, type checking)

- **Code Quality**
  - Fixed SonarCloud S7781: Use String#replaceAll() for modern string replacement (PR #1195)
  - Fixed SonarCloud S1135: Removed TODO comments, documented test isolation patterns (PR #1195)
  - Added ElementFormatter tool for cleaning malformed elements (Issue #1190, PR #1193)

### Security
- Added content size validation (1MB limit) for memory YAML parsing
- Added type safety validation for parsed memory content
- Documented security trade-offs with audit suppressions

### Test Coverage
- Memory portfolio index tests: 8/8 passing (was 3/8)
- All tests properly isolated from user portfolio state
- No regressions introduced (2260+ tests passing)

### Closed Issues
- #1196 - Memory metadata preservation
- #1194 - Test isolation
- #1190 - ElementFormatter tool
- #659 - Tool execution timeout (verified fixed in earlier release)
- #404 - Element system MCP exposure (verified fixed in earlier release)
- #919 - Duplicate tool names (verified fixed in earlier release)

## [1.9.11] - 2025-09-28

### Fixed
- **SonarCloud Quality Improvements**
  - Resolved S1143 violation: unsafe throw in finally block (PR #1162)
  - Fixed async constructor pattern in GitHubRateLimiter (PR #1161)
  - Addressed remaining test file reliability issues (PR #1158)
  - Removed SonarCloud analysis artifacts from tracking (PR #1157)
  - Fixed remaining source file bugs (PR #1156)
  - Resolved regex precedence and ReDoS vulnerabilities (PR #1155)
  - Fixed control character literal usage (PR #1154)
  - Fixed unsafe throw in finally blocks (PR #1153)
  - Removed hardcoded token from validation script (PR #1152)

### Security
- Fixed command injection vulnerabilities in GitHub Actions workflows (Issue #1149)
- Resolved ReDoS vulnerabilities in RelationshipManager by replacing regex with string methods (Issue #1144)

### Improved
- **Test Utilities**: Extracted reusable permission test helpers for cross-platform compatibility
- **Code Quality**: Achieved 82% reduction in SonarCloud reliability bugs (from 55 to 10)
- **Security Posture**: All critical and high severity security issues resolved

## [1.9.10] - 2025-09-27

### Added
- **Enhanced Capability Index** - Major new feature for intelligent element discovery
  - **NLP Scoring System** (PR #1091)
    - Jaccard similarity and Shannon entropy scoring
    - Advanced sampling algorithm for performance
    - Extensible Enhanced Index Manager architecture
    - Verb-based action triggers for natural language queries

  - **Cross-Element Relationships** (PR #1093)
    - GraphRAG-style relationship mapping between elements
    - Automatic discovery of element dependencies and connections

  - **Comprehensive Trigger Extraction** - Extended to all element types
    - Memory elements trigger extraction (PR #1133, Issue #1124)
    - Skills elements trigger extraction (PR #1136, Issue #1121)
    - Template elements trigger extraction (PR #1137, Issue #1122)
    - Agent elements trigger extraction (PR #1138, Issue #1123)
    - Comprehensive trigger extraction documentation (PR #1135)

### Fixed
- **Enhanced Index Stability**
  - Fixed verb extraction with comprehensive configuration support (PR #1125)
  - Fixed undefined metadata handling in EnhancedIndexManager (PR #1110)
  - Fixed loadIndex error and Docker Hub rate limits (PR #1107)
  - Improved type safety in relationship parsing (PR #1106, Issue #1103)
  - Fixed caching issues and added error boundaries (PR #1098)
  - Enhanced trigger validation for Skills and Memories (PR #1140, Issue #1139)

- **Test Infrastructure**
  - Fixed Extended Node compatibility test failures (PR #1141, Issue #1142)
  - Fixed CI test failures in IndexConfig and EnhancedIndexManager (PR #1115)
  - Fixed CI environment tests for GitHub Actions (PR #1114)
  - Fixed Extended Node test failures with Node 22+ (PR #1111)
  - Removed dangerous restore-keys from cache configuration (PR #1109)
  - Added test isolation to prevent file system pollution (PR #1094, #1095)
  - Added memory trigger tests to ESM ignore list (PR #1134)
  - Skip ESM-incompatible tests in CI (PR #1130)

- **Code Quality**
  - Standardized element ID parsing logic (PR #1104, Issue #1099)
  - Moved magic numbers to configuration (PR #1105, Issue #1100)
  - Fixed broken README badge links (PR #1079)

### Improved
- **Performance**: Enhanced Index now includes batching, caching, and memory cleanup mechanisms
- **Security**: Added validation for configuration changes with audit logging
- **Documentation**: Added CHANGELOG_PROCESS.md and restored lost session documentation (PR #1082, #1077)

### Technical Details
- The Enhanced Capability Index provides intelligent element discovery using NLP techniques
- All element types now support trigger extraction for improved searchability
- Comprehensive test coverage improvements and CI reliability fixes
- Node 22+ compatibility fully verified and tested

## [1.9.9] - 2025-09-22

### Added
- **Security Utilities Module** (PR #1072)
  - New `src/utils/securityUtils.ts` with reusable security patterns
  - Prototype pollution protection functions
  - Safe object creation with Object.create(null)
  - Secure property setting with Object.defineProperty()

- **Memory Auto-Repair** (PR #1070)
  - Automatic repair of corrupted memory timestamps during read operations
  - No migration needed - repairs happen transparently
  - Enhanced sorting operations with defensive timestamp conversions

### Fixed
- **Memory Timestamp Crashes** (PR #1070)
  - Fixed toISOString() errors when memory entries have string timestamps (#1069)
  - Added comprehensive timestamp validation with detailed error reporting

- **Security Badge Link** (PR #1071, #1075)
  - Fixed broken security badge link in README pointing to docs/SECURITY.md
  - Badge now correctly points to SECURITY.md at repository root

- **Prototype Pollution False Positives** (PR #1072)
  - Added CodeQL suppressions for false positive alerts (#202-#205)
  - Implemented belt-and-suspenders protection to satisfy code scanners

### Security
- Added comprehensive prototype pollution protection across ConfigManager
- Proper CodeQL suppressions for validated false positives
- Enhanced input validation and sanitization

## [1.9.8] - 2025-09-20

### Added
- **Memory Deletion Support** (PR #1043)
  - Full deletion functionality for memory elements
  - Handles date-based folder structure (YYYY-MM-DD)
  - Cleans up both YAML and optional .storage files
  - Deactivates memories before deletion
  - Fixes issue #1040

- **Memory Editing Support** (PR #1044)
  - Complete edit functionality for memory elements
  - Fixed file extension handling (.yaml for memories, .md for others)
  - Supports field updates including nested properties
  - Version auto-increment on edits
  - Fixes issue #1041

- **Memory Validation Support** (PR #1046)
  - Full validation functionality for memory elements
  - Validates metadata, retention settings, entry structure
  - Supports strict mode for additional quality checks
  - Returns detailed validation reports with errors/warnings
  - Fixes issue #1042

### Improved
- **Code Organization**: Test files moved from root directory to proper test subdirectories (PR #1047)
  - Manual test files now in `test/manual/`
  - Security audit reports in `.security-audit/`
  - Cleaner root directory structure

### Technical Details
- Memory elements now have complete CRUD + validation operations matching other element types
- All memory operations properly handle the date-based folder structure
- Comprehensive test coverage for all new memory operations

## [1.9.7] - 2025-09-20

### Fixed
- **NPM Package Build**: Corrected v1.9.6 NPM package which was built from wrong commit
  - The v1.9.6 tag was created before the memory display fixes were merged
  - This resulted in the NPM package missing the critical memory content display fix
  - v1.9.7 includes all fixes that were intended for v1.9.6
  - Memory elements now correctly display their content instead of "No content stored"

### Note
This release republishes v1.9.6 with the correct code. The memory display fix (PR #1036) and other improvements were merged to main before the v1.9.6 release but the NPM package was accidentally built from an earlier commit.

## [1.9.6] - 2025-09-20

### 🎉 First External Contribution
- **Community Milestone**: This release includes improvements from our first external contributor! Special thanks to **Jeet Singh (@jeetsingh008)** for identifying performance and security improvements in PR #1035.

### Fixed
- **Memory Display Bug**: Added content getter to Memory class (PR #1036)
  - Fixed "No content stored" issue when displaying memory elements
  - Memory files were being loaded but content wasn't accessible
  - Added proper getter method to retrieve content from entries
  - Resolves issue where memories appeared empty despite having content

- **Flaky macOS Tests**: Fixed ToolCache test failures on macOS with Node 22+ (PR #1038)
  - Addressed race condition in directory cleanup
  - Added retry logic for ENOTEMPTY errors during rmdir operations
  - Tests now consistently pass on all platforms and Node versions
  - Particularly affects macOS runners with Node 22.x

### Enhanced
- **Performance Optimization**: Improved whitespace detection in memory file parsing (PR #1037)
  - Replaced regex-based whitespace detection with character code checks
  - Eliminates repeated regex evaluations during format detection
  - More efficient for large memory files
  - *Improvement identified by @jeetsingh008*

### Security
- **Path Validation**: Strengthened path traversal protection (PR #1037)
  - Enhanced validation checks both original and normalized paths
  - Adds validation before path normalization
  - Comprehensive protection against directory traversal attacks
  - *Security enhancement identified by @jeetsingh008*

### Attribution
The performance and security improvements in this release were originally identified and proposed by **Jeet Singh (@jeetsingh008)** in PR #1035. While we implemented these changes internally for security review purposes, full credit goes to Jeet for these valuable contributions. Thank you for helping make DollhouseMCP better! 🙏

## [1.9.5] - 2025-09-19

### Fixed
- **Memory YAML Parsing**: Fixed memory files not displaying correct names for pure YAML format
  - Memory files saved by v1.9.3+ are pure YAML without frontmatter markers
  - MemoryManager.load() now detects pure YAML and wraps it for SecureYamlParser compatibility
  - Added proper handling for nested metadata structure (data.metadata || data)
  - Fixed entries loading to look in correct location (parsed.data.entries)
  - Added edge case handling for empty memory files
  - Fixes issue where v1.9.3/v1.9.4 memory files showed as "Unnamed Memory"

### Enhanced
- **Test Coverage**: Added comprehensive tests for memory file format handling
  - Test for pure YAML files without frontmatter markers
  - Test for files with frontmatter (backward compatibility)
  - Test for empty file handling
  - Test for mixed formats in same directory
  - All 40 MemoryManager tests now passing

### Technical Details
- SecureYamlParser is designed for markdown files with YAML frontmatter
- Memory files are pure YAML, requiring format detection and wrapping
- Solution maintains backward compatibility while fixing the core issue

## [1.9.4] - 2025-09-19

### Fixed
- **Memory Name Display**: Fixed memory elements showing as "Unnamed Memory" in list output
  - Corrected metadata parsing to use `parsed.data` instead of `parsed.metadata`
  - SecureYamlParser returns YAML frontmatter in the `data` property for markdown files
  - Added `parseRetentionDays()` helper to handle various retention formats (permanent, perpetual, "30 days")
  - Memory files are correctly identified as .yaml format only (removed incorrect .md support)
  - Ensures `validateAndResolvePath()` only accepts .yaml and .yml extensions for consistency
  - Fixes PR #1030: All memory names now display correctly instead of showing "Unnamed Memory"

### Technical Details
- The bug was caused by incorrect property path when parsing YAML frontmatter from SecureYamlParser
- Legacy .md files in memories directory are templates/schemas, not actual memory files
- All real memory files are stored as .yaml in date-based folders as designed

## [1.9.3] - 2025-09-19

### Fixed
- **Memory Element MCP Support**: Added complete Memory element support to all MCP tool handlers
  - Fixed "Unknown element type 'memories'" errors in DollhouseMCP client
  - Added Memory case handling to 8 critical methods in src/index.ts:
    - `listElements`: Lists available memories with retention policy and tags
    - `activateElement`: Activates memory and shows status
    - `getActiveElements`: Shows active memories with their tags
    - `deactivateElement`: Deactivates memory elements
    - `getElementDetails`: Shows comprehensive memory details
    - `reloadElements`: Reloads memories from portfolio
    - `createElement`: Creates new memory instances with content
    - `editElement`: Supports editing memory properties
  - Memory infrastructure was already implemented but MCP tool handlers were missing the switch cases
  - Fixes user-reported issue with memories not working in v1.9.2

### Fixed
- **Test Compatibility**: Updated GenericElementTools test to use ensembles instead of memories
  - Test was expecting memories to be unsupported but they are now fully functional
  - Changed test to use ensembles which remain unsupported for creation/editing/validation

## [1.9.2] - 2025-09-19

### Fixed
- **Branch Synchronization**: Resolved divergence between main and develop branches
  - Synchronized documentation updates that were only in develop
  - Fixed security audit suppressions path to use proper location
  - Ensured all v1.9.0 and v1.9.1 features are properly documented

### Enhanced
- **Documentation**: Updated README and CHANGELOG to accurately reflect all implemented features
- **Security Audit**: Corrected suppressions file path from root to proper config location

### Technical Details
- Merged 58 commits from develop that were missing from main
- No actual code changes to Memory element (already fully implemented in main)
- Primary changes are documentation and configuration fixes

## [1.9.1] - 2025-09-19

### Fixed
- **Memory Element Support**: Fixed validation and tool descriptions for memory elements
  - Added 'memories' to all validation arrays in index.ts
  - Updated browse_collection, get_collection_content, and install_collection_content tool descriptions
  - Fixed switch statements to handle memory element type properly
  - Resolves Issue #1019 where browse_collection returned "Invalid type 'memories'" error
  - Memory elements can now be browsed, installed, and managed through all MCP tools

### Technical Details
- Modified validation arrays at lines 2034, 5322, and 5394 in src/index.ts
- Added memory case to element type switch statements
- Updated all collection tool descriptions to include memory elements
- Clean hotfix approach with cherry-picked commit from develop branch

## [1.9.0] - 2025-09-17

### Added
- **Memory Element Implementation**: Complete memory element support with advanced features
  - Persistent context storage across sessions
  - Date-based folder organization for scalability
  - Search indexing with content-based retrieval
  - Retention policies and privacy levels
  - Performance optimizations for large memory sets

### Enhanced
- **Collection Support**: Full memory element support in collection browsing and installation
- **Portfolio System**: Memory elements fully integrated with portfolio management

## [1.8.1] - 2025-09-15

### Fixed
- **Extended Node Compatibility**: Fixed Headers constructor undefined in CI environment
  - Replaced Headers constructor with plain object mock to ensure cross-platform compatibility
  - Previously failing test "should provide helpful error messages for common failures" now passes consistently
  - Improves CI reliability for Extended Node Compatibility workflow
- **Documentation**: Updated website URL to reflect live status (removed "(planned)" designation)
  - Website https://dollhousemcp.com is now live and accessible
  - Updated README chunks and regenerated documentation files

### Improved
- **CI Reliability**: Enhanced test infrastructure for better cross-platform compatibility
- **Test Mocking**: Improved mock strategies to work in both local and CI environments

## [1.8.0] - 2025-09-15

### 🚨 Breaking Changes
- **Configuration Wizard Auto-Trigger Removed**: The configuration wizard no longer appears automatically on first MCP interaction
  - Different LLMs handled auto-insertion unpredictably, causing UX inconsistencies
  - Migration: Wizard still available manually via `config` tool with `action: 'wizard'`

### Added

#### Major Portfolio System Enhancements
- **Configurable Repository Names**: Portfolio repository names now configurable via `TEST_GITHUB_REPO` environment variable
- **Full Portfolio Sync Functionality**: Complete bidirectional sync with GitHub portfolios
  - `sync_portfolio pull` functionality for downloading elements from GitHub
  - Three sync modes: additive (default), mirror, backup
  - Dry-run mode with change preview
  - Progress reporting and conflict resolution
- **Portfolio Pull Handler**: New modular architecture for GitHub portfolio synchronization
  - PortfolioPullHandler for orchestrating pull operations
  - PortfolioSyncComparer for intelligent comparison logic
  - PortfolioDownloader with Unicode normalization and batch processing
- **Enhanced Tool Clarity**: Renamed conflicting tools for better user experience
  - `install_content` → `install_collection_content` (install FROM collection)
  - `submit_content` → `submit_collection_content` (submit TO collection)
  - Maintained `sync_portfolio` for bulk operations

#### GitHub Integration Improvements
- **Portfolio Repository Management**: Comprehensive GitHub repository management
  - Automated repository creation and initialization
  - Smart conflict detection and resolution
  - Authenticated username resolution for portfolio operations
- **Rate Limiting Fixes**: Resolved bulk operation failures
  - Fixed redundant token validation causing GitHub API rate limits
  - Added tokenPreValidated flag to prevent validation on every API call
  - Improved bulk sync success rate from 0% to functional operation
- **Filename Transformation Fix**: Fixed critical portfolio sync issue
  - Resolved mismatch between GitHub filenames and local processing
  - Portfolio pull operations now correctly find and restore files
  - Eliminated "No elements found in GitHub portfolio" errors

#### Test Infrastructure & Environment
- **Isolated Test Environment**: Dedicated test infrastructure with real GitHub integration
  - Created dollhouse-test-portfolio repository for safe testing
  - Docker Compose configuration for test environment
  - Configurable test parameters via environment variables
- **Enhanced Test Coverage**: Comprehensive unit tests for portfolio functionality
  - PortfolioSyncComparer.test.ts (11 test suites, 15 tests)
  - PortfolioDownloader.test.ts (5 test suites, 15 tests)
  - Performance tests for large portfolios (1000+ elements)

### Fixed

#### Critical Portfolio Sync Issues
- **Issue #930**: Portfolio sync pull failures resolved
  - Fixed filename transformation mismatch preventing file restoration
  - GitHub operations now use consistent filename format
- **Issue #913**: Portfolio upload failures with null response errors
  - Fixed IElement object incomplete method implementations
  - Now uses PortfolioElementAdapter pattern for reliable uploads
- **Issue #926**: Rate limiting issues in bulk operations
  - Eliminated redundant token validation calls
  - Batch processing with proper rate limiting

#### GitHub Authentication & API
- **JSON Parsing Error**: Fixed `Unexpected token 'U', "Unauthorized" is not valid JSON` error
  - Added proper response status checking before JSON parsing
  - Improved error messages for authentication failures
- **User Authentication**: Fixed portfolio operations using incorrect usernames
  - Now uses authenticated user's username instead of element author
  - Prevents 404 errors in portfolio sync operations
- **Token Management**: Enhanced GitHub token handling and validation

#### Template System
- **Issue #914**: Template variable interpolation completely broken
  - Refactored template rendering to dedicated TemplateRenderer utility class
  - Fixed variable substitution and validation
  - Added comprehensive error handling and logging

### Performance
- **Portfolio Sync Optimization**: Significant performance improvements
  - Batch index rebuilds (4x faster for large portfolios)
  - Parallel downloads with rate limiting (up to 5x faster)
  - Single index rebuild after all operations complete
- **Test Coverage**: Maintained 97%+ test coverage across all changes
- **CI Reliability**: Enhanced workflow consistency and eliminated flaky tests

### Dependencies
- **@modelcontextprotocol/sdk**: Updated to v1.18.0 (latest MCP protocol features)
- **zod**: Updated to v4.1.8 (schema validation improvements)
- **jsdom**: Updated to v27.0.0 (DOM testing environment enhancements)
- **@types/node**: Updated to v24.4.0 (latest Node.js type definitions)

### Security
- **Input Validation**: Enhanced Unicode normalization to prevent homograph attacks
- **Security Audit Logging**: Added comprehensive logging for portfolio operations
- **Authentication**: Improved GitHub authentication flow reliability
- **YAML Parsing Security**: Enhanced validation to prevent code injection

### Developer Experience
- **Tool Organization**: Organized 41 MCP tools into 6 logical categories
- **Configuration Wizard**: Interactive setup for new installations
- **Debug Infrastructure**: Enhanced logging and error tracking
- **Documentation**: Comprehensive session notes and troubleshooting guides

## [1.7.3] - 2025-09-09

### Security
- **Critical**: Added prototype pollution protection to prevent `__proto__`, `constructor`, and `prototype` injection attacks in ConfigManager
- Achieved 0 security findings across all severity levels in security audit
- Maintained FAILSAFE_SCHEMA usage with documented security rationale for YAML parsing

### Improved
- **ConfigManager Test Coverage**: Increased from 64.5% to 96.8% (+32.3%)
- Forward compatibility: Unknown configuration fields are now preserved during updates
- Enforced secure file permissions (0o700 for directories, 0o600 for files)
- All file operations now use atomic read/write mechanisms

### Fixed
- Fixed YAML "null" string being incorrectly parsed as null value
- Resolved race conditions in file operations
- Corrected file permission issues on Unix systems

### Known Issues
- Test-only: ConfigManager persistence test failing in mock environment (#896)
- Test-only: Two prototype pollution tests not triggering in test environment (#897)

## [1.6.11] - 2025-08-28

### Fixed
- Collection index URL updated to use GitHub Pages instead of raw GitHub URL
- E2E tests now properly prioritize CI environment tokens over local .env files
- MCP tool flow tests handle both string and object response formats for backward compatibility
- Test suite reliability improvements for CI environments

## [1.6.10] - 2025-08-28

### Fixed
- Collection submission pipeline now includes full markdown content with frontmatter (#818)
  - Added missing `localPath` parameter to `submitElementAndHandleResponse()` call
  - Fixes "No frontmatter found" errors in collection workflow
  - Enables proper processing of submitted elements

## [1.6.9] - 2025-08-27

Fix content truncation in create_persona tool - personas were being truncated at 1000 chars

## [1.6.8] - 2025-08-26

### Fixed
- OAuth client ID configuration display issue - `configure_oauth` tool now correctly shows "Using Default" instead of "Not Configured" when using the default GitHub OAuth client ID (#782)

## [1.6.7] - 2025-08-26

Fixed version update script and improved QA test reliability

## [1.6.5] - 2025-08-26

- Portfolio sync fix for markdown elements (#759)
- Intelligent version update system (#760)
- Comprehensive release workflow documentation

All notable changes to DollhouseMCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.4] - 2025-08-25

### Fixed
- **OAuth Helper NPM Packaging** - Fixed missing oauth-helper.mjs file in NPM distribution
  - Added `oauth-helper.mjs` to package.json files array for proper NPM packaging
  - Added additional fallback path in src/index.ts for NPM package installations
  - OAuth authentication now works correctly for users installing from NPM
- **Performance Testing Workflow** - Fixed performance tests failing in CI
  - Changed workflow to run only performance tests instead of entire test suite
  - Used targeted command: `npm test -- test/__tests__/performance/ --no-coverage`
  - Performance monitoring workflow now runs correctly in GitHub Actions

## [1.6.3] - 2025-08-25

### Fixed
- **OAuth Authentication** - Fixed invalid OAuth client ID and added comprehensive error handling
  - Updated default client ID from incorrect `Ov23liXGGP9jNrBhBNfO` to correct `Ov23li9gyNZP6m9aJ2EP`
  - Added unique error codes throughout OAuth flow for precise debugging
  - Added debug logging at each step of the authentication process
  - Improved error messages to be specific and actionable
  - Fixed TypeScript compilation issue with missing DeviceCodeResponse import

## [1.6.2] - 2025-08-25

### Fixed
- **Critical OAuth Bug** - Fixed default client ID not being used in `setup_github_auth`
  - The v1.6.1 release had a bug where `setupGitHubAuth()` bypassed the default fallback
  - Made `GitHubAuthManager.getClientId()` public instead of private
  - Updated `setupGitHubAuth()` to use proper fallback chain
  - Now correctly uses default OAuth client ID when no configuration exists
  - Restores the "just works" authentication experience promised in v1.6.1

## [1.6.1] - 2025-08-25

### Fixed
- **OAuth Default Client ID** - Fixed "just works" authentication for NPM installs
  - Added default DollhouseMCP OAuth Client ID for seamless setup
  - Users can now run `setup_github_auth` without any configuration
  - OAuth device flow with 8-character code works out of the box
  - Maintains backward compatibility with environment variables and config

## [1.6.0] - 2025-08-25

### Added
- **Collection Submission Workflow** (#549) - Complete community contribution pipeline
  - Enhanced `submit_content` tool to optionally submit to DollhouseMCP collection after portfolio upload
  - Automatic GitHub issue creation in collection repository with proper labels
  - New configuration tools: `configure_collection_submission` and `get_collection_submission_config`
  - Opt-in behavior via environment variable or configuration setting
  - Comprehensive error handling with fallback to manual submission
- **OAuth Personal Access Token (PAT) Support** (#724) - Dual-mode authentication for testing
  - Added PAT support alongside OAuth device flow for automated testing
  - Created unified authentication utility for both OAuth and PAT modes
  - Comprehensive test suite for OAuth/PAT functionality
  - Complete documentation for testing vs production authentication
- **Performance Optimizations** (#700) - Significant startup and runtime improvements
  - Tool caching to reduce redundant initialization
  - Lazy loading for collection operations
  - Reduced memory footprint and faster response times
- **QA Test Framework** (#689, #677, #683) - Comprehensive testing infrastructure
  - Added QA metrics and dashboard for test monitoring
  - Implemented test data cleanup mechanism for CI reliability
  - Added comprehensive CI/CD pipeline integration
  - Automated test execution with metrics collection

### Breaking Changes
- **Removed Deprecated Marketplace Aliases** (#548) - Performance improvement
  - Removed 5 deprecated tool aliases that duplicated collection tools
  - Tools removed: `browse_marketplace`, `search_marketplace`, `get_marketplace_persona`, `install_persona`, `submit_persona`
  - **Migration required**: Use `browse_collection`, `search_collection`, `get_collection_content`, `install_content`, `submit_content` instead
  - Reduces tool count by 5, improving MCP initialization performance

### Fixed
- **OAuth Token Persistence** (#719) - Fixed critical authentication issue
  - Replaced unreliable background helper process with main process polling
  - OAuth tokens now persist correctly after device flow authorization
  - Improved reliability and user experience for authentication
- **Build Info Tool Format** (#726) - Fixed MCP protocol compliance
  - Corrected `get_build_info` tool return format to match MCP requirements
  - Tool now returns proper MCP response format instead of plain string
  - Resolves Claude Desktop hanging issue
- **GitHub Token Validation** (#701) - Made token validation more flexible
  - Fixed overly strict token validation that blocked valid tokens
  - Improved compatibility with different GitHub token formats
- **Environment Variable Naming** (#725) - Fixed GitHub Actions compatibility
  - Changed from `GITHUB_TEST_TOKEN` to `TEST_GITHUB_TOKEN`
  - GitHub Actions secrets cannot start with "GITHUB_"

### Security
- **YAML Bomb Detection** (#364) - Comprehensive protection against denial of service
  - Added detection for recursive YAML structures
  - Added circular reference chain detection  
  - Added excessive alias amplification detection
  - Prevents memory exhaustion from malicious YAML patterns

## [1.5.2] - 2025-08-06

### Added
- **Anonymous Collection Access** - Browse and search collection without GitHub authentication (#476)
  - Implemented `CollectionCache` for offline browsing with 24-hour TTL
  - Added `CollectionSeeder` with built-in sample data fallback
  - Collection tools now work without authentication using cached/seed data
- **Anonymous Submission Support** - Submit personas without GitHub authentication (#479)
  - Removed email submission pathway for security (spam/injection prevention)
  - Added rate limiting (5 submissions/hour with 10-second minimum delay)
  - Clear user messaging about GitHub requirement for spam prevention
- **Shared Search Utilities** - Extracted common search functionality to reduce duplication
  - Created `searchUtils.ts` with `normalizeSearchTerm` and `validateSearchQuery`
  - Added Unicode normalization for all search inputs (security)
- **Comprehensive Documentation**
  - Created `ANONYMOUS_SUBMISSION_GUIDE.md` for anonymous usage instructions
  - Added `TESTING_STRATEGY_ES_MODULES.md` documenting ES module test approach
  - Created `MULTI_AGENT_GITFLOW_PROCESS.md` for development workflow

### Fixed
- **OAuth Documentation URL** - Fixed misleading developer registration link (#480)
  - Changed from GitHub app creation URL to proper documentation
  - Critical UX blocker that confused users during OAuth setup

### Security
- **Removed Email Vector** - Eliminated email submission to prevent spam/injection attacks
- **Rate Limiting** - Implemented configurable rate limits for anonymous submissions
- **Unicode Normalization** - All user inputs now sanitized with `UnicodeValidator`
- **Audit Logging** - Added security event logging for cache operations and submissions
- **Path Validation** - Enhanced validation to prevent directory traversal attacks

### Changed
- **Test Organization** - Added `CollectionCache.test.ts` to excluded tests due to ES module mocking

## [1.5.1] - 2025-08-05

### Fixed
- **Critical**: Fixed OAuth token retrieval for collection browsing (#471)
  - `GitHubClient` now uses `getGitHubTokenAsync()` to check both environment variables and secure storage
  - OAuth tokens from `setup_github_auth` are now properly used for API calls
- **Critical**: Fixed legacy category validation blocking collection browsing (#471)
  - Replaced deprecated `validateCategory()` calls with proper section/type validation
  - Collection browsing now accepts valid sections (library, showcase, catalog) and types (personas, skills, etc.)
- **Legacy**: Removed category validation from persona creation tools
  - `create_persona` tool no longer requires or validates categories
  - `edit_persona` allows editing category field for backward compatibility without validation
  - Aligns with element system architecture where categories are deprecated

## [1.5.0] - 2025-08-05

### Added
- **GitHub OAuth Device Flow Authentication** - Secure authentication without manual token management
  - New tools: `setup_github_auth`, `check_github_auth`, `clear_github_auth`
  - AES-256-GCM encrypted token storage with machine-specific keys
  - Natural language OAuth flow with user-friendly instructions
  - Built-in rate limiting and Unicode security validation
  - Automatic token persistence across sessions
- **Comprehensive test coverage** for OAuth implementation (420+ lines of tests)
- **ES module mocking support** using `jest.unstable_mockModule` for better test reliability

### Security
- **Token encryption**: GitHub tokens are now encrypted at rest using AES-256-GCM
- **Machine-specific encryption keys**: Tokens are encrypted with keys derived from machine ID
- **Secure file permissions**: Token storage uses 0o600 file and 0o700 directory permissions
- **Rate limiting**: Built-in protection against brute force token validation attacks

## [1.4.5] - 2025-08-05

### Fixed
- **Critical**: Fixed server startup with npx and CLI commands in Claude Desktop
  - Server now properly detects and handles all execution methods (direct, npx, CLI)
  - No more "Server disconnected" errors when using standard npm installation
  - Added 50ms delay for npx/CLI execution to ensure proper module initialization
  - Better error logging with execution context details

### Changed
- Improved startup detection logic to handle various execution scenarios
- Added global error handlers for better debugging of startup issues

## [1.4.4] - 2025-08-04

### 🚨 Emergency Hotfix
- **v1.4.3 was completely broken** - this release fixes critical initialization failures
- Users on v1.4.3 must upgrade immediately as the server crashes 100% of the time

### Fixed
- **Initialization order bug**: Migration now runs before directory access
  - Previously: Portfolio directories were created before migration could fix them
  - Now: Migration completes before any directory operations
- **jsdom crash on startup**: Heavy dependencies now load lazily
  - Previously: UpdateChecker crashed during MCP initialization
  - Now: jsdom/DOMPurify load only when needed with error handling
- **Docker compatibility**: Server now handles read-only environments gracefully
  - Added proper error handling for directory creation failures
  - Server continues with limited functionality instead of crashing

### Changed
- Made UpdateManager and PersonaImporter optional during initialization
- Improved error visibility with console.error for critical failures
- Better fallback HTML sanitization using entity escaping

## [1.4.3] - 2025-08-04

### 🚨 Critical Fix
- **Fixed NPM installation crash** caused by directory name mismatch
  - v1.4.2 installations were completely broken on clean machines
  - Server would crash silently with no error output

### Changed
- **BREAKING**: All element directories now use plural names consistently
  - Portfolio directories: `personas/`, `skills/`, `templates/`, etc.
  - Data directories: `personas/`, `skills/`, `templates/`, etc.
  - This aligns with semantic correctness (directories contain multiple items)
- Simplified DefaultElementProvider implementation
  - Removed unnecessary mapping layer between directory names
  - Code is now cleaner and more maintainable
- Improved error logging for initialization failures
  - Added console.error output for Claude Desktop visibility
  - Better debugging information when issues occur

### Added
- **Automatic migration** for existing v1.4.2 installations
  - Renames singular directories to plural automatically
  - Preserves all existing content
  - Logs migration progress for transparency
- Comprehensive troubleshooting section in README
  - Clear instructions for v1.4.2 users
  - Directory structure documentation
  - NPM upgrade instructions

### Technical Details
- ElementType enum values changed from singular to plural
  - `'persona'` → `'personas'`
  - `'skill'` → `'skills'`
  - `'template'` → `'templates'`
  - `'agent'` → `'agents'`
  - `'memory'` → `'memories'`
  - `'ensemble'` → `'ensembles'`
- Removed `elementMappings` object from DefaultElementProvider
- Portfolio directories now match data directory names exactly

### Migration Instructions
If upgrading from v1.4.2:
1. Update: `npm install -g @dollhousemcp/mcp-server@latest`
2. The server will automatically migrate your directories on first run
3. No manual intervention required

## [1.4.0] - 2025-08-02

### Changed
- **BREAKING**: Element types now use singular naming convention (#435)
  - Previous: 'skills', 'personas', 'templates', 'agents'
  - New: 'skill', 'persona', 'template', 'agent'
- Standardized element system architecture across all types
- Updated version to 1.4.0 to reflect breaking changes

### Added
- Generic CRUD operations for all element types (from v1.3.4 development)
  - create_element - Create any element type
  - edit_element - Modify element metadata and content
  - validate_element - Comprehensive validation with feedback
  - delete_element - Safe deletion with data cleanup
- Memory and Ensemble element types (placeholders for future release)
- Enhanced security throughout element system

### Fixed
- Sync issues between main and develop branches
- Consolidated naming conventions across codebase
- Resolved version conflicts (main had v1.3.3, develop had v1.3.4)

## [1.3.4] - 2025-08-02

### Added
- **Complete Element System Documentation** (#424): Comprehensive guides for all element types
  - ELEMENT_ARCHITECTURE.md - System design and core concepts
  - ELEMENT_DEVELOPER_GUIDE.md - Step-by-step creation guide
  - ELEMENT_TYPES.md - Reference for all 6 element types
  - API_REFERENCE.md - Complete MCP tool documentation
  - MIGRATION_TO_PORTFOLIO.md - User migration guide
- **Generic Element Tools** (#417, #418, #419): Universal tools for all element types
  - create_element - Create any element type
  - edit_element - Modify element metadata and content
  - validate_element - Comprehensive validation with feedback
  - delete_element - Safe deletion with confirmation

### Fixed
- **CodeQL Security Alerts** (#431): Resolved false positives in test files
  - Added proper suppression configuration
  - Fixed typo in .codeql-suppress filename
  - Enhanced documentation in test files
- **Previously Completed Issues**: Closed issues that were already implemented
  - #417, #418, #419 - Element tools (implemented in PR #422)
  - #402 - NPM_TOKEN already configured

### Changed
- **Issue Prioritization**: Updated priorities for better roadmap clarity
  - Moved Ensemble Runtime Management (#300) to R&D/experimental
  - Adjusted labels to reflect current development focus

### Security
- **Test File Suppressions**: Properly configured CodeQL to handle intentional test patterns
  - ReDoS test patterns now correctly suppressed
  - Security test files properly annotated

## [1.3.2] - 2025-07-29

### Fixed
- **NPM Release Workflow**: Fixed CI environment tests failing during releases
  - Added TEST_PERSONAS_DIR environment variable to release workflow
  - Added test environment preparation step
  - Ensures automated NPM publishing works correctly

## [1.3.1] - 2025-07-29

### Added
- **GitFlow Workflows**: Complete GitHub Actions implementation for GitFlow
  - Automated release creation from release branches
  - PR title validation for GitFlow compliance
  - Branch naming enforcement
  - Protected branch configuration

### Changed
- **Documentation**: Updated all references to reflect flat element structure
  - Removed category-based paths from examples
  - Updated tool documentation for new parameters
  - Fixed MCP tool names in documentation

### Fixed
- **Backward Compatibility**: Added deprecated aliases for old MCP tool names
  - Old tools continue to work with deprecation warnings
  - Smooth transition for existing users

## [1.2.2] - 2025-07-10

### Security
- **Content Sanitization** (#156): Comprehensive XSS prevention in persona content
  - DOMPurify integration with strict no-tags policy
  - Input validation for all user-provided content
  - Safe handling of persona instructions and metadata
- **YAML Injection Prevention** (#171): Secure YAML parsing implementation
  - Schema validation with strict type checking
  - Size limits for YAML documents (100KB default)
  - Protection against prototype pollution and code injection
- **Token Security** (#173): GitHub token exposure prevention
  - Token validation and format checking
  - Secure storage with encryption at rest
  - Token expiration and rotation support
  - Audit logging for token operations
- **Docker Container Security** (#181): Hardened container configuration
  - Non-root user execution (UID 1000)
  - Read-only root filesystem
  - Minimal attack surface with distroless base image
  - Resource limits (100MB memory, 0.5 CPU)
  - No capabilities granted

### Fixed
- **CI Timing Test Flakiness** (#185): Fixed unreliable timing attack tests
  - Skip timing tests in CI environments where they're inherently unreliable
  - Added deterministic security validation tests
  - Enhanced CI detection covering 8+ platforms
  - Maintained strict security thresholds (>50%) for local development

### Added
- Total tests increased from 309 to 487
- Comprehensive security test coverage
- TypeScript compilation fixes for all test files

## [1.2.0] - 2025-07-07

### Added
- **Rate Limiting** (#72): Token bucket algorithm to prevent API abuse
  - Configurable limits (default: 10 checks/hour, 30s minimum delay)
  - Clear error messages with wait times and reset information
  - Rate limit status in server status display
- **Signature Verification** (#73): GPG signature verification for release authenticity
  - Verifies git tag signatures during update checks
  - Shows signature status and signer information
  - Configurable trusted key management
  - Development mode allows unsigned releases
- **CI Environment Tests** (#92): 44 new tests across 3 files
  - Environment variable validation
  - Shell compatibility verification
  - Path safety and traversal prevention
  - Total tests increased from 265 to 309
- **Auto-Update Documentation** (#62): Comprehensive architecture documentation
  - UpdateManager, BackupManager, UpdateChecker, RateLimiter, SignatureVerifier
  - Workflow diagrams and troubleshooting guides
  - Security implementation details
- **NPM Publishing Preparation** (#40): Package ready for npm registry
  - Added "files", "publishConfig", and "funding" fields
  - Created .npmignore file
  - Package size optimized to 278.8 kB

### Security
- Enhanced UpdateChecker security (already implemented in v1.1.0)
- Rate limiting prevents update check abuse
- Signature verification ensures release authenticity
- Comprehensive security testing with 28+ security-specific tests

### Changed
- Total tests increased from 265 to 309
- Enhanced error messages for better user experience
- Improved mock setup for ESM modules in tests

### Fixed
- SignatureVerifier test mock setup issues
- UpdateChecker error handling for non-Error objects
- Path resolution for CI environments

## [1.1.0] - 2025-07-04

### Added
- GitHub Project management integration with automated issue tracking
- Enhanced issue templates with priority indicators and quick summaries
- Platform-specific CI badges for Windows, macOS, and Linux
- Comprehensive development workflow documentation
- Project management scripts for issue organization
- Four milestone roadmap (v1.1.0 through v1.4.0)

### Fixed
- ARM64 Docker build failures (exit code 255) by switching from Alpine to Debian base images
- Docker Compose test timing issues with stdio-based MCP servers
- Docker tag format issues (linux/amd64 → linux-amd64)
- All workflow reliability issues achieving 100% success rate

### Changed
- Docker base images from Alpine to Debian slim for better ARM64 compatibility
- Issue templates to include better project board visibility
- README badges to show individual platform support status

### Security
- Maintained all Docker security hardening (non-root, read-only, resource limits)
- Preserved enterprise-grade GitHub Actions security configuration

## [1.0.0] - 2025-07-01

### Added
- Initial release of DollhouseMCP
- 21 MCP tools for complete persona management
- GitHub-powered marketplace integration
- User identity system with environment-based attribution
- Chat-based persona creation and editing tools
- Auto-update system with backup/rollback capabilities
- Smart installation script with config merging
- Enterprise-grade GitHub Actions workflows
- Comprehensive test suite (79 tests)

### Security
- AGPL-3.0 license with platform stability commitments
- SHA-pinned GitHub Actions for supply chain protection
- User authorization controls for Claude triggers
- Command injection prevention in auto-update system

[1.2.2]: https://github.com/DollhouseMCP/mcp-server/compare/v1.2.0...v1.2.2
[1.2.0]: https://github.com/DollhouseMCP/mcp-server/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/DollhouseMCP/mcp-server/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/DollhouseMCP/mcp-server/releases/tag/v1.0.0