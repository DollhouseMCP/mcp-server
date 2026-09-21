# Beta Release and Deployment CD

The default branch registers two manual release/deployment buttons. Run them
from the `beta` branch:

- **Deploy Beta to Alpha VPS** updates or verifies the hosted alpha server at
  `https://mcp.dollhousemcp.com`.
- **Publish Beta Release** creates the public GitHub prerelease/tag that fans out
  to package publishing and bundle generation.

Both workflows are intentionally manual. They are the beta lane's CD surface; CI
still runs on PRs before anything reaches `beta`.

## Registration and source selection

GitHub registers manual workflows from the default branch, but executes the
workflow definition at the dispatched ref. Merge these files and prerelease-aware
downstream publishers to `main`, then perform the reviewed, history-preserving
`main` → `beta` synchronization **before dispatching**. Adding hardened defaults
only on `main` does not change a workflow dispatched from an older beta commit.

Select `beta` in the Actions branch selector, or pass `--ref beta` to `gh workflow
run`. Both protected environments allow the beta workflow ref; do not relax them
to run from main. Checkout pins the event SHA explicitly. The checked-out beta
source supplies package versions, lockfile, hosted scripts and all dependencies;
main intentionally does not acquire the hosted runtime just to register buttons.
Record that workflow source SHA and the exact release/deployed revision.


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

Keep the `alpha` environment protected with required reviewer approval and a
beta-only branch policy. Deployment defaults to `dry_run: true`: it validates
configuration, prepares temporary SSH material and installs dependencies, but the
remote wrapper opens no SSH connection and performs no public-endpoint check.
The three environment secrets are still required in dry-run mode.

`refs/heads/beta` is normalized to `beta` before the remote clone. For a
controlled release prefer a verified beta tag: a branch ref is resolved again on
the VPS and can advance after workflow dispatch. The deploy workflow executes
the wrapper from its selected beta SHA, while the remote checkout uses `git_ref`.
Confirm the resulting `DEPLOYED_REVISION` against the intended release commit.
Leave backups enabled; use verify/rollback under the same protected environment.

## Publish Beta Release

Workflow: `.github/workflows/publish-beta-release.yml`

Use this after a PR has already updated `package.json` and `manifest.json` to an
exact beta version such as `2.1.0-beta` or `2.1.0-beta.1`.

The workflow validates that:

- it is run from the `beta` branch
- the input version matches `package.json`
- `manifest.json` matches `package.json`
- the version is a `-beta` or `-beta.*` prerelease
- an existing tag/release/npm version is reusable only when its recorded identity
  and channel checks permit retrying missing artifacts
- both the selected immutable checkout and freshly fetched default-branch
  publisher workflows are prerelease-safe

The source checks enforce the sync prerequisite: registered publishers on main
and the beta/tag source used for artifact builds must both contain the reviewed
prerelease guards before the workflow creates public release state. Safe main
workflows alone do not make an older beta checkout safe.

The string-grep checks are bootstrap guards. A future versioned invariant may
replace them, but must preserve validation of both publisher sources.

A non-dry-run publish creates:

- annotated tag `v<version>`
- GitHub prerelease for that tag

The orchestrator explicitly dispatches the existing publishers at the immutable
release tag and waits for their run results. It uses the run ID returned by the
versioned GitHub dispatch API, never a search for a recent run at the same SHA.
An ambiguous dispatch response fails closed; inspect Actions before retrying. A release created with `GITHUB_TOKEN`
does not trigger ordinary downstream event workflows by itself. They publish:

- npm package with the `beta` dist-tag
- GitHub Packages package with the `beta` dist-tag
- `.mcpb` Desktop Extension bundle and checksum attached to the prerelease

Manual npm publish runs support `dry_run`. Manual GitHub Packages runs default
to `dry_run: true`; release events still publish normally after duplicate-version checks pass.

The MCP Registry workflow skips GitHub prereleases.

The beta-release dry run defaults to true and checks source/version/state and
both publisher-source guards, then prepares notes and a summary. It creates no tag or
release and dispatches no publisher. It is **not** a package-build/provenance dry
run: qualify downstream npm/GitHub Packages dry runs separately with their
explicit dry-run inputs. Environment approval is still required. Real publication
requires the exact reviewed beta version, trusted-main safety provenance,
package/artifact evidence and all release gates from #2460.

## Dist-Tag Policy

Release publishing derives package channels from SemVer:

| Version pattern | npm/GitHub Packages dist-tag |
| --- | --- |
| `*-alpha.*` | `alpha` |
| `*-beta`, `*-beta.*` | `beta` |
| `*-rc.*` | `rc` |
| stable version | `latest` |

Unsupported prerelease channels fail closed.
