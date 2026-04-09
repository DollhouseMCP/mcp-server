# Session Notes - April 8, 2026

Date: 2026-04-08 (evening session ~8pm - 2:20am)
Focus: Pre-release bug fixes, UX improvements, and v2.0.11-rc.1 publish
Outcome: Completed - RC published to npm

## Session Summary

Addressed four bug/UX issues blocking the v2.0.11 release, set up Playwright browser testing infrastructure, added a release channel selector to the Setup tab, unified the console port configuration, and published v2.0.11-rc.1 to npm under the `@next` and `@rc` dist-tags.

## Work Completed

### PR #1836 — Auth tab fix + Playwright tests
- Fixed tokenStore not passed in standalone `--web` mode (#1825)
- Fixed blank-on-reload for all lazy-init tabs (#1837) — `lazyInitTab()` missing from localStorage restore path
- Removed window blind collapse from Console Token and TOTP cards (kept on intro card only)
- Set up Playwright test infrastructure: config, 23 browser tests, 12 Jest route tests
- Key files: `src/index.ts`, `src/web/public/security.js`, `src/web/public/security.css`, `src/web/public/app.js`

### PR #1839 — Release channel selector
- Added Stable/RC/Beta dropdown to Setup tab
- Channel controls npm dist-tag in generated configs (`@latest`, `@rc`, `@beta`)
- Renamed "Install Now" to "Configure Now" throughout Setup tab
- Hidden in Pinned version mode (CSS `[hidden]` override for `display: flex`)
- Backend accepts `channel` parameter with allowlist validation
- Key files: `src/web/public/index.html`, `src/web/public/setup.js`, `src/web/public/setup.css`, `src/web/routes/setupRoutes.ts`

### PR #1842 — License form visibility
- Hide activation form when commercial license is active
- Centralized logic in `selectTier()` so all tier transitions handle it (Enterprise<->Commercial, AGPL cancel)
- SonarCloud `var` -> `const` fix
- Key files: `src/web/public/setup.js`

### PR #1843 — Console port config unification
- Added `console.port` to config schema (`~/.dollhouse/config.yml`)
- Resolution hierarchy: CLI flag -> config file -> env var -> default (41715)
- Branded `PortNumber` type with `validatePort()` function
- Runtime validation in `ConfigManager.updateSetting('console.port', ...)`
- Debug logging for port resolution steps
- `ConfigManager.readPortFromYaml()` static method for safe YAML parsing
- 40 tests covering edge cases, validation, EADDRINUSE regression
- Key files: `src/config/ConfigManager.ts`, `src/di/Container.ts`, `src/web/console/UnifiedConsole.ts`, `src/index.ts`

### v2.0.11-rc.1 Published
- Version bumped on `release/2.0.11-rc.1` branch
- Published to npm with `--tag next` (manual, not CI)
- Also tagged as `@rc`
- `@latest` remains on v2.0.10

## Key Decisions

- **Manual RC publish**: CI workflow doesn't support `--tag` for prereleases yet (#1835 Phase 1). Published manually with `--tag next`.
- **Release branch stays open**: Not merged to main. Will merge when promoting to stable v2.0.11.
- **Channel selector uses `rc` value but npm tag is `next`**: Inconsistency noted, acceptable for now. Docs say `@next` for RCs.
- **Playwright browsers in Docker only**: Chromium not installed locally, browser tests run in Docker/CI.
- **`display: flex` overrides `hidden` attribute**: Required explicit `.setup-channel-toggle[hidden] { display: none }` CSS rule.

## Issues and PRs

| Type | Number | Title | Status |
|------|--------|-------|--------|
| PR | #1836 | fix(web): pass tokenStore in standalone --web mode | Merged |
| PR | #1839 | feat(setup): add release channel selector | Merged |
| PR | #1842 | fix(setup): hide activation form when commercial license active | Merged |
| PR | #1843 | feat(config): unify console port configuration | Merged |
| PR | #1844 | release: v2.0.11-rc.1 | Closed (premature) |
| Issue | #1825 | Auth tab broken in standalone --web mode | Closed |
| Issue | #1835 | Beta/RC publishing flow and channel support | Closed (Phase 2 done) |
| Issue | #1837 | Lazy-init tabs blank on reload | Closed |
| Issue | #1840 | Unify console port configuration | Closed |
| Issue | #1841 | Hide license form when active | Closed |

## Key Learnings

- CSS `display: flex` overrides HTML `hidden` attribute — always add `[hidden] { display: none }` for flex containers that may be hidden
- `selectTier()` is the single point of control for tier visibility — form hiding logic belongs there, not scattered across handlers
- SonarCloud hotspots can only be resolved via API or UI review, not `NOSONAR` comments
- The SonarCloud token for sonarcloud.io lives in Claude Desktop config, NOT in env vars (those point to self-hosted)
- `npm publish --provenance` only works on GitHub Actions, not locally
- FAILSAFE_SCHEMA returns strings for numbers — need `Number()` coercion when reading ports from YAML

## Next Session Priorities

1. Test v2.0.11-rc.1 on multiple machines — verify auth tab, channel selector, port config all work end-to-end
2. Fix any bugs found in RC testing — publish as rc.2 if needed
3. Promote to stable v2.0.11 — merge release branch to main, publish to `@latest`
4. CI auto-tagging for prereleases (#1835 Phase 1) — add `--tag` logic to publish workflows
