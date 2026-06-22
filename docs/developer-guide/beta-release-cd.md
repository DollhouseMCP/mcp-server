# Beta Release and Deployment CD

The beta branch has two manual release/deployment buttons:

- **Deploy Beta to Alpha VPS** updates or verifies the hosted alpha server at
  `https://mcp.dollhousemcp.com`.
- **Publish Beta Release** creates the public GitHub prerelease/tag that fans out
  to package publishing and bundle generation.

Both workflows are intentionally manual. They are the beta lane's CD surface; CI
still runs on PRs before anything reaches `beta`.

## Deploy Beta to Alpha VPS

Workflow: `.github/workflows/deploy-beta-alpha-vps.yml`

Use this for the live hosted alpha endpoint. The workflow calls the existing
`npm run hosted:remote` wrapper and then verifies the public endpoint with
`npm run hosted:deploy -- verify`.

Allowed deployment refs are:

- `beta`
- `refs/heads/beta`
- `v*-beta.*` tags

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

Keep the `alpha` environment protected with required reviewer approval until the
hosted deployment path has proved boring.

## Publish Beta Release

Workflow: `.github/workflows/publish-beta-release.yml`

Use this after a PR has already updated `package.json` and `manifest.json` to an
exact beta version such as `2.1.0-beta.1`.

The workflow validates that:

- it is run from the `beta` branch
- the input version matches `package.json`
- `manifest.json` matches `package.json`
- the version is a `-beta.` prerelease
- the tag, GitHub release, and npm version do not already exist
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

## Dist-Tag Policy

Release publishing derives package channels from SemVer:

| Version pattern | npm/GitHub Packages dist-tag |
| --- | --- |
| `*-alpha.*` | `alpha` |
| `*-beta.*` | `beta` |
| `*-rc.*` | `next` |
| stable version | `latest` |

Unsupported prerelease channels fail closed.
