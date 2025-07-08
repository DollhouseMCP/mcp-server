# Changelog

All notable changes to DollhouseMCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.2.0]: https://github.com/DollhouseMCP/mcp-server/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/DollhouseMCP/mcp-server/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/DollhouseMCP/mcp-server/releases/tag/v1.0.0