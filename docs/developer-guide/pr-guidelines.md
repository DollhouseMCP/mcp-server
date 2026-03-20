# Pull Request Guidelines

These guidelines describe what maintainers expect when reviewing changes to DollhouseMCP. Pair them with the workflow overview (`workflow.md`) and the testing strategy (`testing-strategy.md`) so every contribution lands cleanly.

---

## 1. Before You Open a PR

- **Branch naming** – follow the workflow document (`workflow.md`) for prefixes such as `feature/`, `fix/`, `docs/`, `test/`, `refactor/`.
- **Commit style** – use conventional commits (`feat:`, `fix:`, `docs:`, `refactor:` …) and keep individual commits focused. Squashing later is fine as long as the final history remains readable.
- **Pre-commit checks** – run `npm run pre-commit` (security tests + dependency audit) and `npm run lint` to catch issues early.
- **Tests & build** – run `npm test` and `npm run build`, plus any suites affected by your change (integration, security, e2e). Mention skipped suites and why.
- **Docs** – update user or developer documentation if behavior, APIs, or workflows change. Configuration tweaks usually require edits in `docs/guides/` or `docs/architecture/`.

---

## 2. Crafting the Pull Request

Use a short, action-oriented title (`fix: normalize skill parameter names`). In the PR body, cover the essentials:

```markdown
## Summary
- bullet points describing what changed and why

## Testing
- [x] npm test
- [ ] npm run test:integration
- manual: describe any manual checks

## Notes
- risks, follow-up issues, migration steps, or coordination needed
```

Additional sections (screenshots, roll-out instructions) are welcome when they add clarity. Link issues with “Fixes #123”/“Closes #123” so automation can track status.

---

## 3. Review Expectations

- **Put reviewers in the driver’s seat.** Call out files or sections that deserve extra attention (e.g., “EnhancedIndexManager cache invalidation is in commit abc123”).
- **Explain trade-offs.** If you chose one approach over another, document the reasoning in the PR or code comments.
- **Respond to feedback promptly.** When you push updates, add a short comment summarising the change (“Addressed feedback: switch to FileLockManager.atomicWriteFile”). Re-request review once you’re ready for another look.
- **Avoid back-and-forth churn.** If a discussion drifts, jump to a quick synchronous chat or create a follow-up issue to keep the PR tight.

---

## 4. Testing & Verification Checklist

| Change type | Minimum verification |
|-------------|----------------------|
| Code paths touched by unit tests | `npm run build`, `npm test` |
| Handler / DI / tool changes | `npm run test:integration` + manual MCP inspector smoke test |
| Portfolio or sync logic | `npm run test:integration`, dry-run `sync_portfolio`, manual upload/download |
| Enhanced Index | `npm run test:integration`, `get_relationship_stats` after forcing rebuild |
| Security-sensitive code | `npm run test:security`, consider targeted manual tests |
| User-facing docs/UI | Include screenshots or terminal transcripts when relevant |

If a suite is flaky or currently quarantined, document the limitation and reference the tracking issue.

---

## 5. After Review

- **Keep commits tidy.** Amend or squash as needed once feedback is addressed. Avoid force-pushing after reviewers start re-verifying unless you coordinate with them.
- **Confirm CI.** Do not merge while required checks are red unless a maintainer explicitly waives them.
- **Coordinate follow-up work.** Open issues for deferred work (e.g., “Improve memory index performance – follow-up #XYZ”) before merging.

---

## 6. Final Steps & Merge

- Use merge queues or the standard GitHub merge button; avoid pushing directly to `main`.
- Ensure `CHANGELOG.md` or release notes are updated when the change is user-visible.
- Post a short summary in the relevant channel/issue if others are waiting on the change.

Clear, well-documented pull requests save reviewers time and reduce regressions. When in doubt, err on the side of over-communicating context and validating assumptions.***
