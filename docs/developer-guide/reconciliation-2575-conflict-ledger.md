# Clean Hosted Reconciliation Conflict Ledger (#2575)

## Frozen Inputs

| Role | Commit |
| --- | --- |
| Repaired beta first parent | `27b906f721d11b09ffb99f3fbabbf8a8d4043ae3` |
| Trusted hosted second parent | `943b3dc79b48f95969b09c0db07b8be8b25c62e5` |
| Common ancestor | `1d32a76e3d48147326e8b2a7c97961aca39e35b7` |
| Excluded cleanup inventory | `bd98af2f49618ec29f678d11b5e5cffac3772365` |

The candidate starts from repaired beta and merges the exact trusted hosted tip
with `--no-ff`. Neither parent is rebased, squashed, or reconstructed. The
cleanup inventory is evidence only and is not an input to this merge.

## Textual Conflicts

| File | Resolution | Rationale | Verification |
| --- | --- | --- | --- |
| `.github/workflows/claude-code-review.yml` | Keep beta's exact-head checkout and pre/post-review head checks; retain the already merged pinned action, model, and workflow-token configuration | A review must cover the current PR head. The hosted side of the conflict contained only optional commented examples where beta added the post-review integrity check | Workflow validation tests and YAML inspection |
| `tests/integration/auth/storage-parity.test.ts` | Keep both parents' test cases | Beta's malformed security-record tests and hosted's Unicode allowlist canonicalization/collision tests protect independent storage contracts | Focused filesystem auth storage parity suite |

## Auto-Merged Areas Requiring Milestone Validation

Git reported no textual conflict for the remaining trusted hosted changes.
They still require the aggregation gates defined by #2555, with particular
attention to:

- OAuth helper, embedded authorization, allowlist, and TOTP behavior.
- PostgreSQL migrations `0040` through `0049` and storage parity.
- Integration descriptor routing, outbound policy, and credential handling.
- Console account, portfolio, collection, operations, and session modules.
- Agent, ensemble, memory, and MCP-AQL lifecycle behavior.
- Package assets, beta publication guards, hosted deployment, and CI policy.

Any defect discovered in these domains must be fixed through a focused child PR
targeting this candidate. It must not be folded into the ancestry merge commit.

## Required Ancestry Audit

Before the aggregation PR is presented for approval:

```bash
git merge-base --is-ancestor 943b3dc79b48f95969b09c0db07b8be8b25c62e5 HEAD
git rev-list --parents -n 1 HEAD
```

The merge commit must have repaired beta as its first parent and the exact
trusted hosted tip as its second parent. All 98 Todd-authored commits recorded
in #2555 must remain reachable unchanged.
