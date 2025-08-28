# Changelog

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