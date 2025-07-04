# Changelog

All notable changes to DollhouseMCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Persona active indicator system with 2 new MCP tools (Issue #31)
- `configure_indicator` tool for customizing persona indicator display
- `get_indicator_config` tool for viewing current indicator settings
- Environment variable support for persistent indicator configuration
- Multiple indicator styles: full, minimal, compact, and custom
- 23 new tests for indicator functionality (102 total tests)

### Changed
- Total MCP tools increased from 21 to 23
- Enhanced documentation with Claude Desktop setup clarifications

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

[1.1.0]: https://github.com/mickdarling/DollhouseMCP/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mickdarling/DollhouseMCP/releases/tag/v1.0.0