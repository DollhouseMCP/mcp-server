# Safety 1.0.6 release preparation

Prepared 2026-10-22. This document records commands for Mick to run after review;
no publish, publish dry run, tag, GitHub release, merge, or deployment was run.

## Source and version ownership

This narrow draft targets **main**, based on
`b2b93accf670c8c3dfa884e9f6c379bf93768001` (Safety 1.0.4).
It reuses the exact Safety manifest and standalone lock already prepared as
**1.0.6** in dependency-remediation PR #3129 at
`ccb4d8c82fef86550a0a4edba841ce750a1bd0dc`. It does not duplicate that beta
remediation or promote the full beta/server tree. The main root dependency
floor becomes **^1.0.6**, as the existing publisher requires exact equality to
`^` plus the workspace version. Root lock metadata matches those manifests,
but its dependency graph still requires the blocked regeneration below.
The main server remains 2.0.43 with its existing SDK range and locked graph.

Safety runtime source is unchanged from current trusted main
`b2b93accf670c8c3dfa884e9f6c379bf93768001`.
The Safety manifest and standalone lock carry the release version, Jest 30.3.0,
Jest types 30.0.0, TypeScript-ESLint 8.48.1, and the patched YAML/argparse
development closure already prepared in #3129. Existing qualification evidence
belongs to that head and does not establish results for future revisions.

## Required release order and blockers

1. Review and resolve the release blockers on #3129 before releasing the server:
   [noninteractive npx](https://github.com/DollhouseMCP/mcp-server/pull/3129#discussion_r4345332986),
   [commented JSONC](https://github.com/DollhouseMCP/mcp-server/pull/3129#discussion_r4345332995),
   and [nested VS Code config consumers](https://github.com/DollhouseMCP/mcp-server/pull/3129#discussion_r4345333005).
   They concern the server installer, not the unchanged Safety runtime.
2. Complete root lock regeneration and review this narrow main promotion.
   The existing `safety_only` workflow **requires the current exact
   `main` SHA**, including in dry-run mode. Dispatching from `beta`, `develop`,
   this release branch, or a tag will fail before dependency installation.
3. Review the resulting exact current main commit, then run the Safety-only
   dry run below. Confirm Safety succeeds and the entire server job is skipped.
4. With publication approval, publish Safety from that same reviewed main SHA.
   Verify registry version, source identity, and provenance before proceeding.
5. Requalify the server consumer against registry Safety 1.0.6. Only then approve
   the separate beta.3 version/release/publish work. Hosted deployment remains a
   separate action.

The draft carries the exact `packages/safety/package.json` and
`packages/safety/package-lock.json` from the approved release input, root
`package.json` dependency floor `^1.0.6`, and matching root lock/workspace
manifest metadata. Main and that reviewed beta head have identical Safety
source, tests, build configuration, README, and LICENSE. Root closure coherence
is an explicit remaining blocker; no new closure was manually synthesized.
The main server version, SDK graph, and existing publish source guard are
preserved.

### Root lock blocker: exact external regeneration command

The local PreToolUse hook rejected the following command with
`Dangerous command pattern: npm install *`. No alternate resolver, hook bypass,
or manual dependency-closure synthesis was used. The draft's root metadata
edits are **not** a coherent resolved lock graph and must not be treated as one.
Jarvis/Mick must run the exact command in this draft's clean checkout in an
authorized environment, review every root lock change, and commit the result:

```bash
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --offline --workspaces --include-workspace-root
npm ci --ignore-scripts --no-audit --no-fund
npm ls --all
npm run build
```

Review that only changes required by the Safety workspace occur; do not bring
beta's SDK upgrade or unrelated package updates into main. The offline command
may need preexisting reviewed cache entries; if it fails, inspect that failure
before choosing any registry-backed regeneration. Independently validate the
virtual and installed workspace graphs, and repeat relevant main CI before
merge. The standalone Safety lock is already complete and separately tested.

`safety_only` installs using the standalone lock with
`npm ci --ignore-scripts --workspaces=false`, builds only Safety, compares its
version with the root dependency floor, and publishes only Safety. It neither
installs the root lock nor runs tests. Root-lock validation and Safety tests are
therefore review prerequisites, not implicit results of the publish workflow.
The Safety npm Trusted Publisher must authorize `DollhouseMCP/mcp-server`,
workflow `publish-npm.yml`, with no environment, as documented in that workflow.

## Exact commands for Mick after the main promotion

Run from the reviewed repository checkout with authenticated `gh`. Replace the
single placeholder with the **reviewed merged current main commit SHA**, not
this draft's SHA or #3129's SHA. No usable main publication SHA exists yet.

```bash
export SAFETY_SOURCE_SHA='<approved-40-character-current-main-commit-sha>'
[[ "$SAFETY_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1
test "$(gh api repos/DollhouseMCP/mcp-server/git/ref/heads/main --jq .object.sha)" = "$SAFETY_SOURCE_SHA" || exit 1
git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
test "$(git rev-parse refs/remotes/origin/main)" = "$SAFETY_SOURCE_SHA" || exit 1
test "$(git show "$SAFETY_SOURCE_SHA:packages/safety/package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).version))')" = '1.0.6' || exit 1
test "$(git show "$SAFETY_SOURCE_SHA:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).dependencies["@dollhousemcp/safety"]))')" = '^1.0.6' || exit 1
```

After checking that the approved Safety input matches the promoted tree, run
the manual **dry run**:

```bash
gh workflow run publish-npm.yml --repo DollhouseMCP/mcp-server --ref main \
  -f dry_run=true \
  -f safety_only=true \
  -f safety_source_sha="$SAFETY_SOURCE_SHA" \
  -f debug_oidc=false
gh run list --repo DollhouseMCP/mcp-server --workflow publish-npm.yml --event workflow_dispatch --branch main --limit 5
```

Inspect the matching run's head SHA and inputs, then watch that run using
`gh run watch <matching-dry-run-id> --repo DollhouseMCP/mcp-server --exit-status`.
Confirm **Publish safety package** succeeds and **Publish to npm Registry** is
skipped. The dry run temporarily changes Safety to a run-local
`0.0.0-dry-run.<run-id>` version and invokes `npm publish --dry-run --tag dry-run`;
it does not publish 1.0.6 and does not prove publishing credentials work.

After Mick approves publication, verify main still matches the reviewed SHA,
then run the **actual Safety-only publish**:

```bash
test "$(gh api repos/DollhouseMCP/mcp-server/git/ref/heads/main --jq .object.sha)" = "$SAFETY_SOURCE_SHA" || exit 1
gh workflow run publish-npm.yml --repo DollhouseMCP/mcp-server --ref main \
  -f dry_run=false \
  -f safety_only=true \
  -f safety_source_sha="$SAFETY_SOURCE_SHA" \
  -f debug_oidc=false
gh run list --repo DollhouseMCP/mcp-server --workflow publish-npm.yml --event workflow_dispatch --branch main --limit 5
```

Watch the matching actual publish run, verify its exact head SHA, Safety job
success, and server job skipped. If main advanced, stop and review the new main
commit before replacing `SAFETY_SOURCE_SHA` and repeating the dry run.

```bash
npm view @dollhousemcp/safety@1.0.6 version gitHead dist.integrity dist.attestations --json
```

Require version `1.0.6`, the reviewed publish source `gitHead`, and the expected
provenance/integrity. If the workflow reports "already published; skipping",
inspect that existing artifact's source and provenance instead of assuming
that this run published it. Re-run the registry-backed server consumer audit
and signatures qualification before approving beta.3.

## Preparation verification

The 2026-10-22 read-only registry query returned E404 for Safety 1.0.6: it was
unpublished when preparation began. The Safety manifest and standalone lock
are byte-identical to #3129's recorded head. Fresh standalone Safety `npm ci
--ignore-scripts --workspaces=false` passed (515 installed packages, zero
vulnerabilities); build passed and all 79 tests in three suites passed on those
exact inputs. Root lock regeneration was attempted and rejected as described
above; that rejection is an outstanding blocker, not a successful resolution.
The attempted root `npm ci --ignore-scripts --no-audit --no-fund` exited 1
with EUSAGE: the old lock's TypeScript-ESLint 7.18.0 and Jest 29.7.0 workspace
closure does not satisfy the new 8.48.1/30.3.0 manifest. No root build or root
test pass is claimed. Standalone Safety success does not override this blocker.
