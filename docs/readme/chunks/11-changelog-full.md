## 🏷️ Version History

### v1.9.24 - 2025-10-27

**Documentation Release**: Claude Skills Compatibility & Dependency Updates

#### 📖 Documentation
- **Claude Skills Compatibility Section** (#1413)
  - Added prominent README section highlighting 100% lossless round-trip conversion
  - Documents bidirectional conversion between DollhouseMCP Skills and Claude Skills
  - Includes skill-converter usage for CLI-enabled LLMs (Claude Code, Cursor, Gemini Code Assist)
  - Complete metadata, validation, and structure preservation in both directions

- **Merge Strategy Documentation**
  - Documented squash vs. regular merge strategy in `docs/development/PR_BEST_PRACTICES.md`
  - Feature → develop: SQUASH merge (clean history)
  - Develop → main: REGULAR merge (preserves commits)

#### 🔄 Dependency Updates
- `@modelcontextprotocol/sdk` 1.20.1 → 1.20.2
- `posthog-node` 5.10.0 → 5.10.3
- `jsdom` 27.0.0 → 27.0.1 (dev)
- `@types/node` 24.8.1 → 24.9.1 (dev)
- `@modelcontextprotocol/inspector` 0.17.1 → 0.17.2 (dev)

---

### v1.9.23 - 2025-10-26

**Feature Release**: Bidirectional Skills Converter
#### ✨ Features
- **Bidirectional Skills Converter** (#1400, #1401)
  - Lossless conversion between DollhouseMCP Skills and Claude Skills
  - CLI: `dollhouse convert from-anthropic` / `to-anthropic`
  - Automatic format detection and metadata enrichment
  - 100% fidelity roundtrip conversion
  - Comprehensive documentation in `docs/guides/SKILLS_CONVERTER.md`

- **DollhouseMCP Primacy Messaging**
  - README section establishing timeline (July 2025 vs October 2025)
  - Positions DollhouseMCP as superset with 6 element types
  - Professional framing for legal review

#### Technical Details
- 13 converter tests passing
- Security: ZIP size limits, bomb detection, Unicode normalization
- Components: SchemaMapper, ContentExtractor, bidirectional converters
- Performance: Sub-second for small skills, scales to large multi-MB skills

---

### v1.9.21 - 2025-10-23

**Patch Release**: Memory validation system activation and element formatting
#### ✨ Features
- **Element file formatter script** (#1388, fixes #1387)
  - New `scripts/fix-element-formatting.ts` to reformat blob content elements
  - Fixes element files stored as single-line blobs (unreadable in editors)
  - Intelligently adds newlines before/after markdown headers
  - Formats code blocks and YAML structures properly
  - Dry-run mode for safe testing
  - Average line length detection (>200 chars triggers formatting)

#### 🔧 Fixed
- **Background memory validation startup** (#1389)
  - BackgroundValidator service now starts automatically on server initialization
  - Memory entries with UNTRUSTED status will be automatically validated every 5 minutes
  - Trust levels are now properly updated (VALIDATED, FLAGGED, QUARANTINED)
  - Validation runs server-side with zero token cost

#### 🔄 Changed
- **README version history optimization**
  - Limited version history in README to 1.9.x releases only (21 versions instead of 35)
  - Reduced README size from ~75KB to ~61KB for better readability
  - Complete history remains in CHANGELOG.md (source of truth)
  - Updated `generate-version-history.js` minVersion from 1.6.0 to 1.9.0
- **Added missing v1.9.20 changelog entry to README**
  - Previous README was missing the v1.9.20 MCP Registry Publishing Fix

#### Context
The BackgroundValidator service was fully implemented in Issue #1314 (Phase 1: Background validation for memory security) but was never activated. The `backgroundValidator.start()` method was missing from server initialization, causing all memories to remain UNTRUSTED indefinitely.
This patch release adds proper lifecycle management:
- Import backgroundValidator singleton in server initialization
- Start validation service after resource handlers are set up
- Stop service during server cleanup

#### Impact
- Memory security architecture is now fully operational
- UNTRUSTED memories will be automatically validated
- Trust level updates work correctly
- No performance impact (runs in background outside LLM context)

---

### v1.9.20 - 2025-10-17

**Fix Release**: MCP Registry Publishing Compatibility
#### 🔧 Fixed
- MCP Registry publishing case sensitivity issue (#XXXX)
  - Corrected `mcpName` field in package.json to match GitHub organization capitalization
  - Changed from `io.github.dollhousemcp/mcp-server` to `io.github.DollhouseMCP/mcp-server`
  - Resolves NPM package validation errors when publishing to MCP Registry
  - Ensures proper namespace permission matching

#### Context
The MCP Registry performs two case-sensitive validations:
1. Permission check against GitHub org name (`io.github.DollhouseMCP/*`)
2. NPM package validation against `mcpName` field in package.json
The initial implementation incorrectly used lowercase for `mcpName`, causing a validation mismatch. This patch release corrects the capitalization to match our GitHub organization name.

---

### v1.9.19 - 2025-10-17

**Comprehensive Release**: 90 commits including security fixes, PostHog telemetry, MCP registry support, and major cleanup
#### ✨ Features
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

#### 🔒 Security
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

#### 🔧 Fixed
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

#### 🔄 Changed
- Improved whitespace detection performance
- Enhanced path traversal protection mechanisms
- Skip Claude Code Review for Dependabot PRs (#1241)
- Refactored CLAUDE.md into modular documentation (#1270)
- Renamed docs/archive/ to docs/session-history/ (#1277)
- Added node: prefix for built-in module imports
- Reduced cognitive complexity in multiple modules

#### Dependencies
- Updated @modelcontextprotocol/sdk from 1.18.0 to 1.20.0
- Updated jest from 30.0.5 to 30.2.0
- Updated @types/node from 24.4.0 to 24.7.0
- Updated typescript from 5.9.2 to 5.9.3
- Updated multiple dev dependencies
- Added PostHog SDK for telemetry

#### Technical
- OIDC permissions: id-token:write, contents:read
- server.json included in NPM package
- Docker build optimizations and multi-platform support
- Auto-sync README files on develop push
- Enhanced test coverage and reliability
- Improved CI/CD pipeline stability

---

### v1.9.18 - 2025-10-17

**Feature Release**: PostHog remote telemetry (opt-in), MCP Resources support, and operational telemetry foundation
#### ✨ Features
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

#### Documentation
- Added comprehensive telemetry incentive strategy guide
- Updated privacy policy with PostHog opt-in details
- Added session notes for telemetry implementation
- Enhanced README with telemetry opt-in section

#### Test Results
- 2546 tests passing
- Test coverage: >96% maintained
- All CI checks passing across all platforms

---

### v1.9.17 - 2025-10-08

Test isolation and repository cleanup patch
#### 🔧 Fixed
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

#### Chores
- **Repository Organization (#1276)**: Added `.obsidian/` and `test-results/` to .gitignore
- **Documentation Structure (#1277)**: Renamed docs/archive/ to docs/session-history/
- **Docker Best Practices (#1273)**: Enhanced Docker environment file documentation
- **Data Directory Documentation (#1274)**: Added README to data/ directory
- **Documentation Refactor (#1270)**: Improved CLAUDE.md organization and clarity

#### ✨ Features
- **Issue Management (#1251)**: Added orphaned issues checker for repository maintenance
- **Developer Experience (#1275)**: Added dev-notes/ directory for personal documentation
- **CI Improvements**: Added automated release issue verification (#1241)
- **Dependabot Integration (#1241)**: Skip Claude Code Review for Dependabot PRs

#### Test Results
- Main suite: 2269 tests passing (performance tests excluded)
- Performance suite: 62 tests passing (isolated execution)
- Total: 2331 tests passing
- No flaky tests remaining
- CI/CD: All workflows passing across all platforms

---

### v1.9.15 - 2025-10-01

Security patch: Zero-width Unicode bypass vulnerability + SonarCloud cleanup
SECURITY FIX [HIGH]:
- Block zero-width Unicode characters in metadata validation (#1228, #1229)
- Prevents steganography and homograph attacks

CODE QUALITY:
- 228+ SonarCloud issues resolved (#1220-1224)
- 199 security hotspots evaluated (all safe)
- Number.parseInt modernization, String.replaceAll updates

All production security concerns resolved.

---

### v1.9.14 - 2025-09-30

#### 🔧 Fixed
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

#### Code Quality
- Fixed SonarCloud issues in Docker test files:
  - S7018: Sorted apt packages alphabetically in Dockerfile.test-enhanced
  - S7031: Merged consecutive RUN instructions in Dockerfile.test-enhanced
  - S7772: Added `node:` prefix for built-in module imports (4 occurrences)
  - S2486: Added proper error logging for JSON parse exceptions
  - S7780: Used String.raw for grep regex patterns (2 occurrences)
- Added comprehensive test coverage for portfolio search file extensions
- 2,277 tests passing with >96% coverage

#### Documentation
- Added SESSION_NOTES_2025-09-30-AFTERNOON-PR1215-SONARCLOUD-PROCEDURE.md
- Added SONARCLOUD_QUERY_PROCEDURE.md - Critical guide for querying SonarCloud correctly
- Updated CLAUDE.md with naming conventions and style guide for session notes and memories

---

### v1.9.13 - 2025-09-29

#### 🔧 Fixed
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
#### ✨ Features
- **CLI Utility**: migrate-legacy-memories.ts for legacy file migration
- **Diagnostic Method**: getLoadStatus() for memory loading diagnostics
- **Error Tracking**: failedLoads tracking in MemoryManager

#### Code Quality
- Fixed SonarCloud S3776: Reduced cognitive complexity in getLoadStatus()
- Fixed SonarCloud S3358: Replaced nested ternary with if-else chain
- Fixed SonarCloud S7785: Use top-level await instead of promise chain
- Extracted handleLoadFailure() to eliminate code duplication
- Use os.homedir() for cross-platform reliability

#### 🔒 Security
- Fixed DMCP-SEC-004: Added Unicode normalization to CLI input validation

---

### v1.9.12 - 2025-09-29

#### 🔧 Fixed
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

#### 🔒 Security
- Added content size validation (1MB limit) for memory YAML parsing
- Added type safety validation for parsed memory content
- Documented security trade-offs with audit suppressions

#### Test Coverage
- Memory portfolio index tests: 8/8 passing (was 3/8)
- All tests properly isolated from user portfolio state
- No regressions introduced (2260+ tests passing)

#### Closed Issues
- #1196 - Memory metadata preservation
- #1194 - Test isolation
- #1190 - ElementFormatter tool
- #659 - Tool execution timeout (verified fixed in earlier release)
- #404 - Element system MCP exposure (verified fixed in earlier release)
- #919 - Duplicate tool names (verified fixed in earlier release)

---

### v1.9.11 - 2025-09-28

#### 🔧 Fixed
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

#### 🔒 Security
- Fixed command injection vulnerabilities in GitHub Actions workflows (Issue #1149)
- Resolved ReDoS vulnerabilities in RelationshipManager by replacing regex with string methods (Issue #1144)

#### 🔄 Changed
- **Test Utilities**: Extracted reusable permission test helpers for cross-platform compatibility
- **Code Quality**: Achieved 82% reduction in SonarCloud reliability bugs (from 55 to 10)
- **Security Posture**: All critical and high severity security issues resolved

---

### v1.9.10 - 2025-09-27

#### ✨ Features
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
#### 🔧 Fixed
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

#### 🔄 Changed
- **Performance**: Enhanced Index now includes batching, caching, and memory cleanup mechanisms
- **Security**: Added validation for configuration changes with audit logging
- **Documentation**: Added CHANGELOG_PROCESS.md and restored lost session documentation (PR #1082, #1077)

#### Technical Details
- The Enhanced Capability Index provides intelligent element discovery using NLP techniques
- All element types now support trigger extraction for improved searchability
- Comprehensive test coverage improvements and CI reliability fixes
- Node 22+ compatibility fully verified and tested

---

### v1.9.9 - 2025-09-22

#### ✨ Features
- **Security Utilities Module** (PR #1072)
  - New `src/utils/securityUtils.ts` with reusable security patterns
  - Prototype pollution protection functions
  - Safe object creation with Object.create(null)
  - Secure property setting with Object.defineProperty()

- **Memory Auto-Repair** (PR #1070)
  - Automatic repair of corrupted memory timestamps during read operations
  - No migration needed - repairs happen transparently
  - Enhanced sorting operations with defensive timestamp conversions

#### 🔧 Fixed
- **Memory Timestamp Crashes** (PR #1070)
  - Fixed toISOString() errors when memory entries have string timestamps (#1069)
  - Added comprehensive timestamp validation with detailed error reporting

- **Security Badge Link** (PR #1071, #1075)
  - Fixed broken security badge link in README pointing to docs/SECURITY.md
  - Badge now correctly points to SECURITY.md at repository root

- **Prototype Pollution False Positives** (PR #1072)
  - Added CodeQL suppressions for false positive alerts (#202-#205)
  - Implemented belt-and-suspenders protection to satisfy code scanners

#### 🔒 Security
- Added comprehensive prototype pollution protection across ConfigManager
- Proper CodeQL suppressions for validated false positives
- Enhanced input validation and sanitization

---

### v1.9.8 - 2025-09-20

#### ✨ Features
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

#### 🔄 Changed
- **Code Organization**: Test files moved from root directory to proper test subdirectories (PR #1047)
  - Manual test files now in `test/manual/`
  - Security audit reports in `.security-audit/`
  - Cleaner root directory structure

#### Technical Details
- Memory elements now have complete CRUD + validation operations matching other element types
- All memory operations properly handle the date-based folder structure
- Comprehensive test coverage for all new memory operations

---

### v1.9.7 - 2025-09-20

#### 🔧 Fixed
- **NPM Package Build**: Corrected v1.9.6 NPM package which was built from wrong commit
  - The v1.9.6 tag was created before the memory display fixes were merged
  - This resulted in the NPM package missing the critical memory content display fix
  - v1.9.7 includes all fixes that were intended for v1.9.6
  - Memory elements now correctly display their content instead of "No content stored"

#### Note
This release republishes v1.9.6 with the correct code. The memory display fix (PR #1036) and other improvements were merged to main before the v1.9.6 release but the NPM package was accidentally built from an earlier commit.

---

### v1.9.6 - 2025-09-20

#### 🎉 First External Contribution
- **Community Milestone**: This release includes improvements from our first external contributor! Special thanks to **Jeet Singh (@jeetsingh008)** for identifying performance and security improvements in PR #1035.

#### 🔧 Fixed
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

#### Enhanced
- **Performance Optimization**: Improved whitespace detection in memory file parsing (PR #1037)
  - Replaced regex-based whitespace detection with character code checks
  - Eliminates repeated regex evaluations during format detection
  - More efficient for large memory files
  - *Improvement identified by @jeetsingh008*

#### 🔒 Security
- **Path Validation**: Strengthened path traversal protection (PR #1037)
  - Enhanced validation checks both original and normalized paths
  - Adds validation before path normalization
  - Comprehensive protection against directory traversal attacks
  - *Security enhancement identified by @jeetsingh008*

#### Attribution
The performance and security improvements in this release were originally identified and proposed by **Jeet Singh (@jeetsingh008)** in PR #1035. While we implemented these changes internally for security review purposes, full credit goes to Jeet for these valuable contributions. Thank you for helping make DollhouseMCP better! 🙏

---

### v1.9.5 - 2025-09-19

#### 🔧 Fixed
- **Memory YAML Parsing**: Fixed memory files not displaying correct names for pure YAML format
  - Memory files saved by v1.9.3+ are pure YAML without frontmatter markers
  - MemoryManager.load() now detects pure YAML and wraps it for SecureYamlParser compatibility
  - Added proper handling for nested metadata structure (data.metadata || data)
  - Fixed entries loading to look in correct location (parsed.data.entries)
  - Added edge case handling for empty memory files
  - Fixes issue where v1.9.3/v1.9.4 memory files showed as "Unnamed Memory"

#### Enhanced
- **Test Coverage**: Added comprehensive tests for memory file format handling
  - Test for pure YAML files without frontmatter markers
  - Test for files with frontmatter (backward compatibility)
  - Test for empty file handling
  - Test for mixed formats in same directory
  - All 40 MemoryManager tests now passing

#### Technical Details
- SecureYamlParser is designed for markdown files with YAML frontmatter
- Memory files are pure YAML, requiring format detection and wrapping
- Solution maintains backward compatibility while fixing the core issue

---

### v1.9.4 - 2025-09-19

#### 🔧 Fixed
- **Memory Name Display**: Fixed memory elements showing as "Unnamed Memory" in list output
  - Corrected metadata parsing to use `parsed.data` instead of `parsed.metadata`
  - SecureYamlParser returns YAML frontmatter in the `data` property for markdown files
  - Added `parseRetentionDays()` helper to handle various retention formats (permanent, perpetual, "30 days")
  - Memory files are correctly identified as .yaml format only (removed incorrect .md support)
  - Ensures `validateAndResolvePath()` only accepts .yaml and .yml extensions for consistency
  - Fixes PR #1030: All memory names now display correctly instead of showing "Unnamed Memory"

#### Technical Details
- The bug was caused by incorrect property path when parsing YAML frontmatter from SecureYamlParser
- Legacy .md files in memories directory are templates/schemas, not actual memory files
- All real memory files are stored as .yaml in date-based folders as designed

---

### v1.9.3 - 2025-09-19

#### 🔧 Fixed
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

#### 🔧 Fixed
- **Test Compatibility**: Updated GenericElementTools test to use ensembles instead of memories
  - Test was expecting memories to be unsupported but they are now fully functional
  - Changed test to use ensembles which remain unsupported for creation/editing/validation

---

### v1.9.2 - 2025-09-19

#### 🔧 Fixed
- **Branch Synchronization**: Resolved divergence between main and develop branches
  - Synchronized documentation updates that were only in develop
  - Fixed security audit suppressions path to use proper location
  - Ensured all v1.9.0 and v1.9.1 features are properly documented

#### Enhanced
- **Documentation**: Updated README and CHANGELOG to accurately reflect all implemented features
- **Security Audit**: Corrected suppressions file path from root to proper config location

#### Technical Details
- Merged 58 commits from develop that were missing from main
- No actual code changes to Memory element (already fully implemented in main)
- Primary changes are documentation and configuration fixes

---

### v1.9.1 - 2025-09-19

#### 🔧 Fixed
- **Memory Element Support**: Fixed validation and tool descriptions for memory elements
  - Added 'memories' to all validation arrays in index.ts
  - Updated browse_collection, get_collection_content, and install_collection_content tool descriptions
  - Fixed switch statements to handle memory element type properly
  - Resolves Issue #1019 where browse_collection returned "Invalid type 'memories'" error
  - Memory elements can now be browsed, installed, and managed through all MCP tools

#### Technical Details
- Modified validation arrays at lines 2034, 5322, and 5394 in src/index.ts
- Added memory case to element type switch statements
- Updated all collection tool descriptions to include memory elements
- Clean hotfix approach with cherry-picked commit from develop branch

---

### v1.9.0 - 2025-09-17

#### ✨ Features
- **Memory Element Implementation**: Complete memory element support with advanced features
  - Persistent context storage across sessions
  - Date-based folder organization for scalability
  - Search indexing with content-based retrieval
  - Retention policies and privacy levels
  - Performance optimizations for large memory sets

#### Enhanced
- **Collection Support**: Full memory element support in collection browsing and installation
- **Portfolio System**: Memory elements fully integrated with portfolio management

---

For complete release history prior to v1.9.0, see the [GitHub Releases](https://github.com/DollhouseMCP/mcp-server/releases) page.