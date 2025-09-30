## 🏷️ Version History

### v1.9.14 - September 30, 2025

**Bug Fixes**: ElementFormatter and portfolio search improvements

#### 🔧 Fixed
- **ElementFormatter Security Scanner False Positives** - Fixed validation option being ignored (#1211, #1212)
  - SecureYamlParser now properly respects `validateContent: false` option
  - ElementFormatter uses `validateContent: false` for all YAML parsing (5 locations)
  - Local trusted files can bypass content scanning while maintaining security for untrusted sources
  - Improved memory name generation: derives from filenames instead of auto-generated IDs
  - Example: `sonarcloud-rules-reference` instead of `mem_1759077319164_w9m9fk56y`

- **Portfolio Search File Extension Display** - Fixed incorrect extension display (#1213, #1215)
  - Portfolio search now shows correct file extensions based on element type
  - Memories display `.yaml` extension, other elements show `.md` extension
  - Added `getFileExtension()` public method to PortfolioManager
  - No breaking changes, display-only fix

#### 🛠️ Code Quality
- Fixed 10 SonarCloud issues in Docker test files:
  - S7018: Sorted apt packages alphabetically
  - S7031: Merged consecutive RUN instructions
  - S7772: Added `node:` prefix for built-in modules (4 occurrences)
  - S2486: Added proper error logging for JSON parse exceptions
  - S7780: Used String.raw for regex patterns (2 occurrences)
- Added comprehensive test coverage for portfolio search file extensions

#### 📚 Documentation
- Added SONARCLOUD_QUERY_PROCEDURE.md - Critical guide for querying SonarCloud correctly
- Updated CLAUDE.md with naming conventions and style guide for session notes
- Added session notes documentation for PR #1215

#### 📊 Statistics
- 2 Bug fixes merged (PR #1212, #1215)
- 10 Code quality issues resolved
- 2,277 tests passing with >96% coverage
- Quality Gate: PASSING
- Test Coverage: >96% maintained

---

### v1.9.13 - September 29, 2025

**Memory System Critical Fixes**: Security scanner improvements and enhanced error reporting

#### 🔧 Fixed
- **Security Scanner False Positives** - Fixed memory system rejecting legitimate security documentation (#1206, #1207)
  - Memory files with security terms (vulnerability, exploit, attack) now load correctly
  - Local memory files are now pre-trusted (validateContent: false)
- **Silent Error Reporting** - Added visible error reporting for failed memory loads
  - Users now see "Failed to load X memories" with detailed error messages
  - New getLoadStatus() diagnostic method for troubleshooting
- **Legacy Memory Migration** - New migration tool for old .md files
  - Migrates to .yaml format in date-organized folders
  - Safe archiving of original files, dry-run mode by default

#### ✨ Added
- CLI Utility: migrate-legacy-memories.ts for legacy file migration
- Diagnostic Method: getLoadStatus() for memory loading diagnostics
- Error Tracking: failedLoads tracking in MemoryManager

#### 🛠️ Code Quality
- Fixed SonarCloud S3776: Reduced cognitive complexity in getLoadStatus()
- Fixed SonarCloud S3358: Replaced nested ternary with if-else chain
- Fixed SonarCloud S7785: Use top-level await instead of promise chain
- Extracted handleLoadFailure() to eliminate code duplication
- Use os.homedir() for cross-platform reliability

#### 🔒 Security
- Fixed DMCP-SEC-004: Added Unicode normalization to CLI input validation

#### 📊 Statistics
- 3 Critical fixes merged in PR #1207
- 7 Code quality issues resolved
- 1 Security issue fixed
- Quality Gate: PASSING
- Test Coverage: >96% maintained

---

### v1.9.12 - September 29, 2025

**Memory System Stability**: Portfolio index and test isolation improvements

#### 🔧 Fixed
- **Memory Metadata Preservation** - Fixed PortfolioIndexManager overwriting memory metadata (#1196, #1197)
  - Memory descriptions now properly preserved instead of "Memory element"
- **Test Isolation** - Fixed memory portfolio index tests contaminating real user portfolio (#1194, #1195)
  - Tests now use temporary directories
  - Added security validation for memory YAML parsing (size limits, type checking)
- **ElementFormatter Tool** - Added tool for cleaning malformed elements (#1190, #1193)

#### 🛠️ Code Quality
- Fixed SonarCloud S7781: Use String#replaceAll() for modern string replacement
- Fixed SonarCloud S1135: Removed TODO comments, documented test isolation patterns

#### 🔒 Security
- Added content size validation (1MB limit) for memory YAML parsing
- Added type safety validation for parsed memory content
- Documented security trade-offs with audit suppressions

#### 📊 Statistics
- Memory portfolio index tests: 8/8 passing (was 3/8)
- Closed issues: #1196, #1194, #1190, #659, #404, #919
- Quality Gate: PASSING
- Test Coverage: >96% maintained

---

### v1.9.11 - September 28, 2025

**SonarCloud Quality & Security**: Major code quality improvements and security fixes

#### 🔒 Security Fixes
- Fixed command injection vulnerabilities in GitHub Actions workflows (#1149)
- Resolved ReDoS vulnerabilities in RelationshipManager (#1144)
- All critical and high severity issues resolved

#### 🛠️ Quality Improvements
- **82% reduction in SonarCloud reliability bugs** (from 55 to 10)
- Fixed unsafe throw in finally blocks (S1143)
- Fixed async constructor patterns
- Resolved regex precedence issues
- Fixed control character usage
- Removed hardcoded tokens

#### 📊 Statistics
- 11 Pull Requests merged for quality fixes
- Quality Gate: PASSING
- Security: All critical issues resolved
- Test Coverage: >96% maintained

### v1.9.10 - September 27, 2025

**Enhanced Capability Index & Security**: Complete trigger extraction system and SonarCloud integration

#### ✨ Major Features
- **Enhanced Capability Index System** - NLP scoring with Jaccard similarity and Shannon entropy
- **Cross-Element Relationships** - GraphRAG-style relationship mapping
- **Complete Trigger Extraction** - All element types now support trigger extraction
- **SonarCloud Integration** - Quality gate PASSING with 0% duplication

#### 🔒 Security Improvements
- Fixed 16 SonarCloud BLOCKER issues
- GitHub Actions command injection vulnerabilities resolved
- Full SHA pinning for all Actions
- PATH manipulation vulnerability fixed

#### 🛠️ Improvements
- Extended Node compatibility fixes
- Enhanced Index stability improvements
- Type-safe relationship parsing
- Docker Hub rate limit mitigation
- Test isolation and CI improvements

#### 📊 Statistics
- 34 Pull Requests merged
- Test Coverage: 98.17%
- Security Hotspots: 100% reviewed
- Code Duplication: 0% on new code

---

### v1.9.9 - September 22, 2025

**Security & Stability**: Prototype pollution protection and memory timestamp fixes

#### ✨ Features
- **Security Utilities**: New reusable security module for prototype pollution protection
- **Memory Auto-Repair**: Corrupted memory timestamps now auto-repair during read operations
- **Enhanced Validation**: Comprehensive timestamp validation with detailed error reporting

#### 🔧 Fixed
- **Memory Timestamps**: Fixed toISOString errors when memory entries have string timestamps (#1069)
- **Security Badge**: Fixed broken security badge link in README pointing to wrong location
- **Prototype Pollution**: Added belt-and-suspenders protection to satisfy code scanners (#202-#205)

#### 🔒 Security
- Added `securityUtils.ts` module with reusable security patterns
- Implemented Object.create(null) for prototype-less objects
- Added Object.defineProperty() for secure property setting
- Proper CodeQL suppressions for validated false positives

---

### v1.9.8 - September 20, 2025

**Memory System Complete**: Full CRUD operations and enhanced memory management

#### ✨ Features
- **Memory CRUD Operations**: Complete create, read, update, delete functionality for memories
- **Memory Editing**: Full support for editing memory fields including metadata and content
- **Memory Validation**: Comprehensive validation with detailed error reporting
- **Enhanced Search**: Improved search across all sources with duplicate detection

#### 🔧 Fixed
- **Memory Display**: Fixed "No content stored" issue when memories have valid content
- **Test Coverage**: Maintained >96% test coverage with comprehensive memory tests
- **Documentation**: Updated all documentation to reflect new memory features

---

### v1.9.7 - September 20, 2025

**NPM Package Fix**: Corrected build issue from v1.9.6

#### 🔧 Fixed
- **NPM Package Build**: Republished with correct commit including all memory display fixes
- **Memory Display**: Memories now correctly show content instead of "No content stored"
- Note: v1.9.6 NPM package was accidentally built from wrong commit

---

### v1.9.6 - September 20, 2025

**🎉 First External Contribution**: Performance and security improvements from the community!

#### ✨ Highlights
- **Fixed**: Memory display bug - added content getter to Memory class (PR #1036)
- **Fixed**: Flaky macOS tests on Node 22+ (PR #1038)
- **Enhanced**: Optimized whitespace detection for better performance (PR #1037)
- **Security**: Strengthened path traversal protection (PR #1037)
- **Attribution**: Thanks to @jeetsingh008 for identifying improvements!

---

### v1.9.5 - September 19, 2025

**Memory YAML Parsing Fix**: Resolved display issues with pure YAML memory files

#### 🔧 Bug Fixes
- **Fixed**: Memory files showing incorrect names for pure YAML format
- **Enhanced**: Added comprehensive test coverage for memory file formats
- **Technical**: Improved compatibility between SecureYamlParser and pure YAML

---

### v1.9.4 - September 19, 2025

**Memory Name Display Fix**: Corrected "Unnamed Memory" display issue

#### 🔧 Bug Fixes
- **Fixed**: Memory elements showing as "Unnamed Memory" in list output
- **Fixed**: Corrected metadata parsing path in SecureYamlParser
- **Technical**: Added retention format parsing for various formats

---

### v1.9.3 - September 19, 2025

**Memory Element MCP Support**: Complete MCP tool handler integration

#### 🔧 Bug Fixes
- **Fixed**: Added Memory element support to all MCP tool handlers
- **Fixed**: Resolved "Unknown element type 'memories'" errors
- **Technical**: Added Memory case handling to 8 critical methods

---

### v1.9.2 - September 19, 2025

**Branch Synchronization**: Documentation and configuration alignment

#### 🔧 Improvements
- **Fixed**: Resolved divergence between main and develop branches
- **Enhanced**: Updated documentation to reflect all features
- **Technical**: Merged 58 commits from develop branch

---

### v1.9.1 - September 19, 2025

**Memory Element Hotfix**: Fixed validation and tool descriptions

#### 🔧 Bug Fixes
- **Fixed**: Added 'memories' to validation arrays
- **Fixed**: Updated collection tool descriptions
- **Technical**: Clean hotfix for memory element support

---

### v1.9.0 - September 19, 2025

**🎉 Memory Element Release**: Persistent context storage with enterprise-grade features

#### ✨ New Features
- **Memory Element**: Complete implementation of persistent context storage (PR #1000 - The Milestone PR!)
- **Date-based Organization**: Automatic folder structure (YYYY-MM-DD) prevents flat directory issues
- **Content Deduplication**: SHA-256 hashing prevents duplicate storage (Issue #994)
- **Search Indexing**: Fast queries across thousands of entries with O(log n) performance (Issue #984)
- **Privacy Levels**: Three-tier access control (public, private, sensitive)
- **Retention Policies**: Automatic cleanup based on age and capacity

#### 🔧 Improvements
- **Performance Optimizations**: 60-second cache for date folder operations
- **Collision Handling**: Automatic version suffixes for same-named files
- **Atomic Operations**: FileLockManager prevents corruption and race conditions
- **Sanitization Caching**: SHA-256 checksums reduce CPU usage by ~40% during deserialization
- **Retry Logic**: Search index building with exponential backoff

#### 🛡️ Security
- **Comprehensive Input Validation**: All memory content sanitized with DOMPurify
- **Path Traversal Protection**: Robust validation in MemoryManager
- **Size Limits**: DoS protection with 1MB memory and 100KB entry limits
- **Audit Logging**: Complete security event tracking

#### 🧪 Testing
- **89 Memory Tests**: Comprehensive coverage across 4 test suites
- **Concurrent Access Tests**: Thread safety verification
- **Security Coverage**: XSS, Unicode attacks, path traversal
- **CI Improvements**: Fixed GitHub integration test conflicts (PR #1001)

---

### v1.8.1 - September 15, 2025

**CI Reliability Improvements**: Fixed persistent test failures across platforms

#### 🔧 Bug Fixes
- **GitHub API 409 Conflicts**: Enhanced retry mechanism with jitter for parallel CI jobs
- **Windows Performance Tests**: Platform-specific timing thresholds for CI environments
- **Test Stability**: Resolved flaky tests in Extended Node Compatibility workflow

---

### v1.8.0 - September 15, 2025

**Major Portfolio System Enhancements**: Full GitHub portfolio synchronization

#### ✨ New Features
- **Portfolio Sync**: Complete bidirectional sync with GitHub portfolios
- **Pull Functionality**: Download elements from GitHub portfolios (3 sync modes)
- **Configurable Repos**: Portfolio repository names now configurable
- **Configuration Wizard**: Now manual-only (removed auto-trigger for better UX)

#### 🔧 Improvements
- **Tool Clarity**: Renamed conflicting tools for better user experience
- **Rate Limiting**: Fixed redundant token validation causing API limits
- **GitHub Integration**: Comprehensive repository management

---

### v1.7.4 - September 12, 2025

**Hotfix Release**: Critical build and registration fixes

#### 🔧 Bug Fixes
- **Build Infrastructure**: Fixed missing TypeScript files in dist
- **Tool Registration**: Resolved MCP tool availability issues
- **Skill System**: Fixed skill registration and activation
- **Test Framework**: Restored test infrastructure functionality

---

### v1.7.3 - September 9, 2025

**Security & Configuration Release**: Prototype pollution protection and config management

#### 🛡️ Security
- **Prototype Pollution Protection**: Comprehensive validation against injection attacks
- **YAML Security**: Maintained FAILSAFE_SCHEMA with security documentation
- **Security Audit**: Achieved 0 security findings across all severity levels

#### ✨ Improvements
- **Configuration Management**: Complete overhaul with atomic operations
- **Test Coverage**: Comprehensive security and configuration tests
- **Input Normalization**: All inputs normalized at MCP request layer

---

### v1.7.2 - September 7, 2025

**Security Patch Release**: Critical logging vulnerability fixes

#### 🛡️ Security Fixes
- **Clear-text Logging Prevention**: Comprehensive sanitization of sensitive data
- **OAuth Token Protection**: Prevents exposure of tokens in console output
- **API Key Sanitization**: Masks all credentials before logging

---

### v1.7.1 - September 3, 2025

**Maintenance Release**: Documentation and compatibility improvements

#### 🔧 Improvements
- **Documentation**: Updated for better clarity and accuracy
- **Compatibility**: Enhanced cross-platform support
- **Bug Fixes**: Various minor fixes and optimizations

---

### v1.7.0 - August 30, 2025

**Major Feature Release**: Enhanced portfolio and collection systems

#### ✨ New Features
- **Portfolio Management**: Improved local portfolio organization
- **Collection Integration**: Better integration with community collection
- **Security Enhancements**: Critical security fixes from code review

---

### v1.6.11 - August 28, 2025

**Test Reliability & Collection Fixes**: Improved test suite stability and fixed collection system

#### 🔧 Bug Fixes
- **Collection Index URL**: Fixed to use GitHub Pages for better reliability
- **E2E Test Tokens**: Improved token prioritization for CI environments
- **Response Format**: Enhanced compatibility with various response formats
- **Type Safety**: Improved TypeScript types throughout test suite

#### ✨ Improvements
- Added helper functions for better code organization
- Enhanced test reliability in CI/CD pipelines
- General code quality improvements

---

### v1.6.10 - August 28, 2025

**Collection Submission Fix**: Critical fix for collection submission pipeline

#### 🔧 Bug Fixes
- **Collection Submission**: Fixed workflow failing due to missing element types
- **Local Path Parameter**: Added missing localPath parameter to submission tool
- **Duplicate Detection**: Added detection for duplicate portfolio uploads and collection issues

#### ✨ Improvements
- Added comprehensive QA tests for collection submission validation
- Cleaned up QA documentation files
- Updated all documentation to v1.6.10

---

### v1.6.9 - August 26, 2025

**Critical Fixes**: Fixed OAuth helper NPM packaging and performance testing workflow

#### 🔧 Bug Fixes
- **OAuth NPM Packaging**: Fixed missing `oauth-helper.mjs` file in NPM distribution
  - File was present in repository but not included in published package
  - OAuth authentication now works correctly for NPM users
- **Performance Tests**: Fixed CI workflow running all tests instead of performance tests
  - Performance monitoring now works correctly in GitHub Actions

---

### v1.6.3 - August 25, 2025

**OAuth Authentication Fix**: Fixed invalid OAuth client ID and improved error handling

#### 🔧 Bug Fixes
- **OAuth Client ID**: Updated from incorrect ID to correct `Ov23li9gyNZP6m9aJ2EP`
- **Error Messages**: Improved clarity of OAuth error messages for better debugging
- **Setup Tool**: Fixed `setup_github_auth` tool to properly handle authentication flow

---

### v1.6.2 - August 25, 2025

**Critical Hotfix**: Fixed OAuth default client ID not being used in `setup_github_auth` tool

#### 🔧 Bug Fixes
- **OAuth Default Client**: Fixed `setup_github_auth` tool not using default client ID when none provided
- **Authentication Flow**: Restored ability to authenticate without manual client ID entry

#### 📝 Documentation
- Added troubleshooting guide for OAuth issues
- Updated setup instructions with clearer OAuth configuration steps

---

### v1.6.1 - August 25, 2025

**⚠️ Breaking Changes**:
- 🔄 **Serialization Format Change** - `BaseElement.serialize()` now returns markdown with YAML frontmatter instead of JSON

#### 🔧 Bug Fixes
- **Serialization Format**: Fixed `BaseElement.serialize()` to return markdown format
  - Changed from JSON string to markdown with YAML frontmatter
  - Maintains consistency with existing persona format
  - Fixes portfolio round-trip workflow

#### ✨ Improvements
- **Code Quality**: Extracted validation methods into ValidationService
- **Error Handling**: Improved validation error messages with specific field information
- **Test Coverage**: Added comprehensive tests for markdown serialization

---

### v1.6.0 - August 25, 2025

**🚀 Major Release: Portfolio System & OAuth Integration**

This release introduces the complete portfolio management system with GitHub OAuth authentication, enabling secure cloud-based element synchronization and management.

#### ✨ New Features

##### 🔐 GitHub OAuth Authentication
- **OAuth App Integration**: Full OAuth flow with GitHub for secure authentication
- **Personal Access Token Support**: Alternative authentication method for CI/CD
- **Token Management**: Secure storage and rotation of authentication tokens
- **Multi-Account Support**: Handle multiple GitHub accounts seamlessly

##### 📦 Portfolio Management System
- **Cloud Sync**: Automatic synchronization between local and GitHub portfolios
- **Version Control**: Full git integration for portfolio elements
- **Conflict Resolution**: Smart merging of local and remote changes
- **Batch Operations**: Upload/download multiple elements efficiently

##### 🛠️ New MCP Tools (42 total)
- `setup_github_auth`: Interactive GitHub OAuth setup
- `check_github_auth`: Verify authentication status
- `refresh_github_token`: Rotate OAuth tokens
- `sync_portfolio`: Bidirectional portfolio synchronization
- `upload_to_portfolio`: Upload local elements to GitHub
- `download_from_portfolio`: Download elements from GitHub
- `submit_to_portfolio`: Submit elements for review
- And 30 more tools for complete portfolio management

#### 🔧 Bug Fixes
- **Element Detection**: Fixed smart detection of element types
- **YAML Parsing**: Improved handling of complex YAML structures
- **Path Resolution**: Fixed Windows path compatibility issues
- **Token Security**: Enhanced token storage encryption

#### 📝 Documentation
- Comprehensive OAuth setup guide
- Portfolio management tutorials
- Troubleshooting guides for common issues
- API documentation for all new tools

#### 🔒 Security
- OAuth token encryption at rest
- Secure token transmission
- Rate limiting for API calls
- Audit logging for all operations

---

For complete release history prior to v1.6.0, see the [GitHub Releases](https://github.com/DollhouseMCP/mcp-server/releases) page.