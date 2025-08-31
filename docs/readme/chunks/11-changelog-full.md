## 🏷️ Version History

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

##### 🛠️ New MCP Tools (37 total)
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