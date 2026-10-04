# Central memory UPDATE adapter: local qualification

Status: locally qualified; publication and conditional merge authorized under the bounded audit exception below. Hosted CI/PostgreSQL and final-head reviews remain required. No hosted PostgreSQL run, deployment or activation is claimed by this prepublication record.

Base: beta `bfcf0d86540f169144ca087d44c7b8074b914518`. Branch: `codex/2906-central-update-adapter`.

Scope was recorded before implementation in [#2906](https://github.com/DollhouseMCP/mcp-server/issues/2906#issuecomment-5974017381). The [architecture contract](../architecture/memory-head-update-adapter.md) describes this dormant existing-owner, same-name, same-locator UPDATE slice and the remaining all-writer activation gates.

## Source review

Independent Sol 6.1 review accepted these source blobs after its findings were corrected:

| Source | Git blob |
| --- | --- |
| `src/storage/MemoryHeadUpdateAdapter.ts` | `1f182019c122126cdd7abc3b1856c69f08c37032` |
| `src/elements/memories/MemoryManager.ts` | `5caec01c6c8e516eef60e9ff464d642400ab2df9` |
| `src/elements/memories/Memory.ts` | `cf17451d0efc8237ac59e873ff77a87402b6641b` |
| `src/elements/base/ElementLoader.ts` | `13178eea93e3c1e004d8656a2f7d30a9945ff840` |
| `src/elements/base/BaseElementManager.ts` | `b4bf9ee78a74f12a84cd03d848a0db3df386730b` |

The final implementation preserves full backend authority, refuses unsupported caller preconditions, checks tenant and file-root context before mutation/publication, and snapshots working state without replaying retention/quarantine. It publishes detached committed state and records genuine commit authority before publication callbacks. Refused and unknown outcomes preserve pending evidence; unknown outcome blocks another write from the same instance. Production dependency injection does not construct the adapter.

## Local checks

| Check | Observed result |
| --- | --- |
| New adapter suite | 14/14 passed, including separate-process stale-write interference and genuine postcommit release failure |
| Existing memory save-limit and name-repair compatibility | 33/33 passed; retained combined run had 12 adapter cases plus these 33; subsequent change added two tests only |
| Generic base manager and skill persistence compatibility | 71/71 passed |
| Production TypeScript | Passed |
| Scoped unit TypeScript | Passed with the retained historical scoped configuration; not a claim that broad repository test typing is clean |
| Changed-source/unit lint and fixture lint | Passed |
| New PostgreSQL test lint | Passed |
| Normal `npm run pre-commit` | 108 rapid security tests passed, 46 skipped; script types passed; dependency audit failed on the unchanged cohort below |
| Source security audit | Zero high/critical or medium findings; three inherited LOW DMCP-SEC-006 observations |
| `git diff --check` | Passed |

The three source-audit observations concern unchanged `FileMemoryOwnedHeadEvidence.ts`, `FileMemoryFence.ts`, and `FileMemoryAbortIntentCodec.ts`. Their existing caller-audit analysis and bounded refusal-audit follow-up remain in [#2906](https://github.com/DollhouseMCP/mcp-server/issues/2906#issuecomment-5956682199). No suppression was added.

Six real PostgreSQL cases are authored using the existing required-CI isolated fixture: successive manager/self-save commits, stale-copy preservation, child and tag invalidation, dirty load refusal, and tenant/RLS isolation. They have not run locally and must actually execute in CI before qualification. Fixture cleaning is test setup, not a production reconciliation procedure.

Using unchanged repository test compiler settings, the scoped PostgreSQL file reports only inherited `src/portfolio/types.ts:35` TS1205. The same diagnostic is reproduced by an existing-suite control and is tracked by [#2544](https://github.com/DollhouseMCP/mcp-server/issues/2544). An earlier fixture imported 85 additional existing mock-helper diagnostics; the final test uses real dependencies and no longer imports those errors. No shared helper or compiler setting was changed to suppress diagnostics. This is not a clean broad `build:test` claim.

Development failures remain retained: the initial file guard compared `/var` with canonical `/private/var`, the fixture initially assumed nested metadata survived entry sanitization, and the snapshot hydration seam initially lost extensions. The corrected tests pass; the initial failures are not retroactively described as clean.

## Dependency publication decision

Initial local qualification audit SHA-256: `94d49ccda4919564e3159719642d3b192460b6988ef2aa653e0a40e51dc29720`, byte-identical to the [retained final audit](evidence/database-reconciliation-2026-10-03-final-full-audit.json).

After approval, the fresh publication audit SHA-256 is `1f237e25163f3baf72a04228ef4701a3edaafcce12472a36921667a58b4e01ed`, byte-identical to the [other retained audit](evidence/database-reconciliation-2026-10-03-full-audit.json). Compared with the initial audit, only npm's effects-list metadata differs: `jest-haste-map` lists an additional `jest-runner` edge and `jest-message-util` omits that edge. Advisory IDs, severity, affected ranges, installed nodes, counts and exposure are unchanged. Both raw variants were retained during #2991 qualification; this is not a new advisory or a dependency change.

Counts: 57 total, 37 high, 19 moderate, 1 low, 0 critical. The high dependency cohort remains the same braces advisory, GHSA-vfj7-8cjw-p6xm. No manifest, lockfile, Dockerfile or dependency change is included. The normal audit remains failed; it was not bypassed or suppressed.

Mick approved a separate bounded exception for this central UPDATE adapter PR and its qualification corrections on October 3, 2026 at 23:32 UTC (message `Sentinel_a00646dcd9988191a6967d705ca10e18`). The approval was forwarded unchanged by the coordinator after verifying the existing candidate and beta base. The question explicitly covered publication for fresh CI/reviews and merge into beta only after all CI and final reviews pass; Mick answered “Yes.” The earlier #2991 exception was not transferred automatically.

This approval covers only the unchanged GHSA-vfj7-8cjw-p6xm development paths/exposure in this adapter PR. A new high/critical advisory or exposure change holds publication/merge for a new decision. Qualification corrections within this bounded PR do not need separate per-commit approval, but do require fresh exact-head checks and reviews. No hook suppression, deployment or storage activation is authorized.

Vulnerable copies remain in the copied safety-workspace development tree of the recorded runtime image. Dynamic/transitive runtime reachability remains unresolved; absence from root application dependencies is not proof of absence from the image. [#2988](https://github.com/DollhouseMCP/mcp-server/issues/2988) remains open. This local candidate does not remediate that issue or authorize deployment.

The new PR must target beta and obtain fresh checks, actual PostgreSQL execution, Codex and Claude reviews, and Sonar qualification on its final commit. Existing merge authorization does not waive those gates. This record must be supplemented by exact-head hosted evidence rather than treating foundation PR results as adapter qualification.

## Retained local receipts

### Invalid-candidate refusal correction

The first published head, `4bc6ad4af5f9110ca13ce4450a1614e977c88771`, received a [Codex P2 finding](https://github.com/DollhouseMCP/mcp-server/pull/2992#discussion_r4175423377): its refusal classifier misspelled the backend's `EINVALIDHEAD` code as `EHEADINVALID`. This misclassified a conclusively rejected candidate as an unknown write and prevented a corrected save on the same working instance.

The correction changes only that production error-code entry. A regression sends malformed YAML through the actual owned-file backend, verifies the rejected candidate bytes, original token, error identity and unchanged persisted snapshot, then verifies a corrected save on the same instance commits revision 2 and clears pending evidence. It fails with the original typo and passes with the correction. The full adapter suite now passes 15/15; scoped TypeScript and changed-file lint also pass. Independent review accepted adapter blob `650ee1a0ebdee8735505c82a39d346bca7c47207` and test blob `db5cde55776dae798e8fa9ba542def078fe930bc`. The source table and earlier hosted checks above remain historical; the correction requires fresh hosted qualification and reviews.

Correction receipts: `/tmp/2992-invalid-head-correction-receipt.txt`, `/tmp/2992-invalid-head-red.log`, `/tmp/2992-invalid-head-green.log`, `/tmp/2992-invalid-head-types.log`, and `/tmp/2992-invalid-head-lint.log`.

Sonar's remaining S6582 readability finding was corrected by using optional chaining for the missing-binding guard. Tenant validation guarantees a nonempty string before the comparison, so an absent binding still refuses before any later state access. All 15 adapter cases, production TypeScript and changed-file lint pass after this change; independent review accepted adapter blob `e093a52797b77828571e4ec9b6ce93c8d5e1f478`. Receipts are `/tmp/2992-optional-chain-runtime.log`, `/tmp/2992-optional-chain-types.log`, and `/tmp/2992-optional-chain-lint.log`. No finding suppression or test limit change was made.

### PostgreSQL tag-fixture correction

The first head's [required PostgreSQL job](https://github.com/DollhouseMCP/mcp-server/actions/runs/37162361720/job/111318247039) executed all six new cases: five passed and the tag case failed during fixture setup. Migration 0057 requires `app.current_user_id` to match the tag owner, even for a maintenance connection. The bare maintenance INSERT omitted that context. The correction uses the ordinary application's transaction with transaction-local tenant context, then performs the same real tag INSERT. The existing stale-save and full-snapshot-preservation assertions remain unchanged. Production behavior and test deadlines are unchanged.

Independent review accepted test blob `e150c4aa00ef154e09739b37ac3edd744e46650d`; test lint passed and scoped repository-settings typing still reports only the inherited TS1205 described above. No local PostgreSQL execution is claimed. The failed full run (168 of 169 suites passed; 3,278 tests passed, one failed, 24 skipped) is retained in `/tmp/2992-4bc6-postgresql-terminal.log`. All six cases and the complete required job must pass on the corrected published head before merge.

- `/tmp/2906-local-qualification-receipt.md` and `/tmp/2906-central-update-source-freeze.txt`
- `/tmp/2906-qualified-adapter-runtime.log`, `/tmp/2906-final-focused-runtime.log`, `/tmp/2906-generic-compatibility.log`
- `/tmp/2906-final-production-types.log`, `/tmp/2906-qualified-unit-types.log`, `/tmp/2906-qualified-lint.log`, `/tmp/2906-worker-lint.log`
- `/tmp/2906-owned-pg-static-qualification.md` and its repository-settings/control logs
- `/tmp/2906-precommit.log`, `/tmp/2906-source-security-audit.log`, `/tmp/2906-current-full-audit.json`, `/tmp/2906-approved-publication-audit.json`

These paths are local receipts, not public CI links. The retained raw audit linked above is repository evidence; hosted qualification is still pending.
