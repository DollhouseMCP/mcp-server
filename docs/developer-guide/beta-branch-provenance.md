# Beta Branch Provenance

This note documents the provenance of the hosted Streamable HTTP beta branch so
future PRs preserve authorship and make the work visible in GitHub review.

## Branch Shape

The `beta` branch was created from `develop` and then merged with
`codex/hosted-http-integration`.

Current intent:

- `develop` remains the normal integration branch.
- `beta` carries the hosted Streamable HTTP integration for beta stabilization,
  CI/CD, and distribution testing.
- `codex/hosted-http-integration` remains the source integration branch for the
  hosted HTTP work that fed this beta branch.

## Attribution

The hosted Streamable HTTP integration contains substantial work authored by
Todd Dibble / `@insomnolence`, including the web console, hosted auth,
database-backed storage, route hardening, and related integration work.

As of the beta branch bootstrap, the commit history from `develop..beta`
includes these author counts:

```text
312  Dibble <tdibble@gmail.com>
 74  Mick Darling <184286+mickdarling@users.noreply.github.com>
 17  insomnolence <insomnolence@users.noreply.github.com>
```

This attribution should remain visible in GitHub commit history, blame, and
contributor views as long as the history is preserved.

## Merge Guidance

When opening PRs from `beta` to `develop`, and later from the release path to
`main`, use a merge strategy that preserves individual commits.

Recommended:

- Use a normal merge commit.
- Keep the authored commit history intact.
- Mention Todd / `@insomnolence` explicitly in the PR description.

Avoid:

- Squash merging this branch, unless the squash commit body deliberately carries
  complete co-author attribution and the team accepts the loss of visible commit
  history.
- Rebase/cherry-pick workflows that rewrite Todd's authored commits under a
  different author identity.

Suggested PR description language:

```markdown
This beta branch brings in the hosted Streamable HTTP integration work,
primarily authored by Todd Dibble / @insomnolence, plus follow-up deployment,
Cloudflare, CI, and stabilization work.

Please preserve commit history when merging so the original authorship remains
visible in GitHub history and contributor views.
```

## Verification Commands

Use these commands before opening or merging the beta PR:

```bash
git shortlog -sne origin/develop..origin/beta
git log --format='%h %an <%ae> %s' origin/develop..origin/beta --author='Todd\|Dibble\|insomnolence'
```

The first command summarizes authorship across the beta delta. The second
spot-checks the hosted integration commits that should remain visible.
