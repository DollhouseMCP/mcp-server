# DollhouseMCP Todo List - Current Status

## 🔴 Immediate Priorities (v1.2.2 Release)
- [ ] Publish v1.2.2 to NPM with security enhancements (#40)
- [ ] Update CHANGELOG.md with v1.2.2 security fixes
- [ ] Create GitHub release for v1.2.2
- [ ] Update README to highlight security features

## 🟠 High Priority - Security Enhancements
- [ ] Implement rate limiting for token validation (#174)
- [ ] Add async cache refresh for tokens (#175)
- [ ] Implement unicode normalization for security (#162)

## 🟡 High Priority - User Features
- [ ] Create persona export functionality
- [ ] Implement persona import with validation
- [ ] Add persona sharing via URL feature
- [ ] Create persona creation guide
- [ ] Document security best practices

## 🟢 Medium Priority - Testing & Quality
- [ ] Fix flaky timing test on macOS (#148)
- [ ] Create MCP protocol integration tests (#29)
- [ ] Research multi-platform MCP compatibility (#30)
- [ ] Create E2E tests with Claude Desktop

## 🔵 Medium Priority - Developer Experience
- [ ] Create VS Code extension for DollhouseMCP
- [ ] Create interactive setup wizard
- [ ] Build RESTful API for persona management
- [ ] Write comprehensive API documentation

## 🟣 Medium Priority - Marketplace Features
- [ ] Build web-based persona editor UI
- [ ] Implement persona rating/review system
- [ ] Add usage statistics for personas
- [ ] Create persona template library
- [ ] Implement persona versioning system

## ⚪ Medium Priority - Performance
- [ ] Implement lazy loading for large collections
- [ ] Optimize startup time performance

## 🔷 Medium Priority - CI/CD & Infrastructure
- [ ] Implement secure environment variable logging (#111)
- [ ] Add container vulnerability scanning to CI (#184)

## ⬜ Low Priority - Advanced Features
- [ ] Add persona chaining/composition feature
- [ ] Add webhook support for events
- [ ] Implement GraphQL endpoint
- [ ] Create plugin system architecture

## 🔶 Low Priority - Monitoring & Analytics
- [ ] Add performance monitoring (APM)
- [ ] Add performance benchmarking suite
- [ ] Set up error tracking with Sentry
- [ ] Create security dashboard (#168)
- [ ] Create metrics collection system (#179)

## ◻️ Low Priority - Infrastructure
- [ ] Review tmpfs size limits for production (#182)
- [ ] Add Docker health check (#183)
- [ ] Implement token rotation support (#176)
- [ ] Add granular permission system (#177)
- [ ] Implement automated release workflow
- [ ] Add preview deployments for PRs

## 🔸 Low Priority - Long-term Vision
- [ ] Record video tutorials
- [ ] Support other AI platforms beyond Claude
- [ ] Implement persona marketplace monetization
- [ ] Create enterprise features package
- [ ] Build admin dashboard for marketplace
- [ ] Add internationalization (i18n) support

---

## 📊 Summary Statistics
- **Total Tasks**: 50
- **Immediate (v1.2.2)**: 4
- **High Priority**: 8
- **Medium Priority**: 17
- **Low Priority**: 21

## 🎯 Current Focus
1. **v1.2.2 Release** - All security fixes complete, ready to publish
2. **User Features** - Export/import/sharing (highly requested)
3. **Performance** - Rate limiting and async improvements

## ✅ Recently Completed
- SEC-001: XSS Prevention (PR #156)
- SEC-003: YAML Injection Prevention (PR #171)
- SEC-004: GitHub Token Exposure (PR #173)
- SEC-005: Docker Container Security (PR #181)

## 📝 Notes
- Security implementation is 100% complete
- Focus shifting to user-facing features per Mick's preference
- All 487 tests passing
- CI/CD is stable and reliable
- Node 24 (not LTS until October 2025)