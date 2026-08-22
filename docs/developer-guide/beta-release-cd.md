# Beta Release and Deployment CD

The beta lane is designed around two manual release/deployment buttons:

- **Deploy Beta to Alpha VPS** updates or verifies the hosted alpha server at
  `https://mcp.dollhousemcp.com`.
- **Publish Beta Release** creates the public GitHub prerelease/tag that fans out
  to package publishing and bundle generation.

Both workflows are intentionally manual. They are the beta lane's CD surface; CI
still runs on PRs before anything reaches `beta`.

> **Default-branch prerequisite:** GitHub registers `workflow_dispatch` only
> when the dispatcher file exists on the repository's default branch. The beta
> publishing implementation lives in
> `.github/workflows/publish-beta-release.yml` as a reusable workflow. This change
> includes the thin `.github/workflows/publish-beta.yml` dispatcher; both reviewed
> workflow files must reach `main` before the button becomes available.
> That thin dispatcher must expose the three documented inputs, grant only
> `actions: write` and `contents: write`, guard
> `github.ref == 'refs/heads/main'`, and call the reusable workflow at an
> immutable reviewed revision. For a same-repository dispatcher, use
> `uses: ./.github/workflows/publish-beta-release.yml`; GitHub resolves that
> local reusable workflow from the exact caller commit. Never call mutable
> `@main` or `@beta` workflow code with the dispatcher's write token. Until
> that main PR is merged, GitHub will not display a working
> **Publish Beta** button. Merging only this beta-side work does not satisfy
> that prerequisite. Do not remove the dispatcher while the reusable workflow is
> present; that would leave operators without a manual beta publication path.

The dispatcher's reusable-workflow call must pass `source_ref: beta` explicitly.

## Deploy Beta to Alpha VPS

Workflow: `.github/workflows/deploy-beta-alpha-vps.yml`

Use this for the live hosted alpha endpoint. The workflow calls the existing
`npm run hosted:remote` wrapper and then verifies the public endpoint with
`npm run hosted:deploy -- verify`.

Allowed deployment refs are:

- `beta`
- `refs/heads/beta`
- SemVer beta tags, such as `v2.1.0-beta.1` or `v2.1.0-beta.1.1`

The workflow requires the `alpha` GitHub environment to provide these secrets:

| Name | Purpose |
| --- | --- |
| `DOLLHOUSE_ALPHA_SSH_TARGET` | SSH target, for example `root@203.0.113.10` |
| `DOLLHOUSE_ALPHA_SSH_PRIVATE_KEY` | Private SSH key used only for this deploy |
| `DOLLHOUSE_ALPHA_KNOWN_HOSTS` | Pinned known-hosts entry for the VPS |

Optional `alpha` environment variables:

| Name | Default |
| --- | --- |
| `DOLLHOUSE_ALPHA_PUBLIC_BASE_URL` | `https://mcp.dollhousemcp.com` |
| `DOLLHOUSE_ALPHA_HOSTNAME` | `mcp.dollhousemcp.com` |
| `DOLLHOUSE_ALPHA_CADDY_TRUSTED_PROXIES` | unset |

Protect the `alpha` environment with required reviewer approval and restrict its
deployment branches to `beta`. The workflow also rejects dispatches whose own
run ref is not `refs/heads/beta`, but the environment restriction is the trust
boundary because branch-authored workflow code can change its own shell guards.

## Publish Beta Release

Default-branch dispatcher: `.github/workflows/publish-beta.yml`

Reusable beta implementation: `.github/workflows/publish-beta-release.yml`

Use this after a PR has already updated `package.json` and `manifest.json` to an
exact beta version such as `2.1.0-beta` or `2.1.0-beta.1`.

The workflow validates that:

- the reusable workflow is given the explicit `beta` source branch
- the input version matches `package.json`
- `manifest.json` matches `package.json`
- the version is strict SemVer with a `beta` prerelease identifier
- any existing tag, GitHub release, or npm version is a safe, matching retry state
- the default branch release workflows are prerelease-safe

The final default-branch check matters because GitHub release/tag events are
evaluated from the default branch. Before publishing the first beta prerelease,
the default branch must already have prerelease-aware publish workflows so a beta
package cannot become the npm `latest` dist-tag.

That default-branch check is a bootstrap guard. Once the prerelease-safe publish
workflows have permanently reached the default branch, replace the string-grep
assertions with a simpler versioned invariant or remove the guard as part of the
normal release workflow cleanup.

A non-dry-run publish creates:

- annotated tag `v<version>`
- GitHub prerelease for that tag

The existing release/tag workflows then publish the artifacts:

- npm package with the `beta` dist-tag
- GitHub Packages package with the `beta` dist-tag
- `.mcpb` Desktop Extension bundle and checksum attached to the prerelease

Manual npm publish runs support `dry_run` and an explicit `debug_oidc` input for
OIDC diagnostics. Manual GitHub Packages runs default to `dry_run: true`; tag
pushes still publish normally after duplicate-version checks pass.

The MCP Registry workflow skips GitHub prereleases.

## Protected Publishing Environments

The npm, GitHub Packages, MCP Registry, and MCPB jobs use the
`release-publish` environment. Configure it before publishing:

- require reviewer approval
- allow only `main` and protected release tags matching `v*`
- configure npm Trusted Publishing for the `release-publish` environment

Manual publish dispatches are accepted only when the workflow run itself comes
from `main`. Release-triggered jobs must come from an allowed protected tag.
The protected environment is the authoritative control; workflow-level ref
checks are defense in depth and are not a substitute for environment rules.

## Dist-Tag Policy

Release publishing derives package channels from SemVer:

| Version pattern | npm/GitHub Packages dist-tag |
| --- | --- |
| `*-alpha.*` | `alpha` |
| `*-beta`, `*-beta.*` | `beta` |
| `*-rc.*` | `next` |
| stable version | `latest` |

Unsupported prerelease channels fail closed.
