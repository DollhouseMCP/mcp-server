# MCP Registry Publishing

This guide documents the **current** MCP Registry publishing flow for DollhouseMCP.

It replaces the older mental model of a manual submission guide. In this repository, MCP Registry publishing is now driven by repository metadata, release automation, and validation tests.

## What Matters

The current MCP Registry flow is built around four things:

- [server.json](../../server.json)
- [.github/workflows/publish-mcp-registry.yml](../../.github/workflows/publish-mcp-registry.yml)
- [tests/workflows/mcp-registry-workflow.test.ts](../../tests/workflows/mcp-registry-workflow.test.ts)
- [tests/workflows/test-mcp-registry-workflow.sh](../../tests/workflows/test-mcp-registry-workflow.sh)

If you understand those files, you understand the publishing path.

## Source Of Truth

### `server.json`

`server.json` is the MCP Registry metadata artifact. It tells the registry what this server is, what package backs it, and what version should be published.

For DollhouseMCP, the important fields are:

- `name`: MCP Registry identifier
- `title`: user-facing display name
- `version`: registry-facing version
- `repository`: GitHub source metadata
- `packages[0].identifier`: npm package name
- `packages[0].version`: npm package version
- `packages[0].transport.type`: currently `stdio`

This file must stay aligned with `package.json`.

### `package.json`

`package.json` still drives the npm package itself, but it also matters to MCP Registry publishing because:

- the versions must match
- `server.json` must be included in the published package `files` array
- the npm package name must match the package identifier declared in `server.json`

## How Publishing Happens

Publishing to the MCP Registry is automated by the `Publish to MCP Registry` GitHub Actions workflow.

The workflow:

1. runs when a GitHub release is published
2. can also be started manually with `workflow_dispatch`
3. installs dependencies and builds the package
4. downloads a pinned `mcp-publisher` binary
5. verifies its checksum
6. authenticates to the MCP Registry using GitHub OIDC
7. runs `mcp-publisher publish`

That means MCP Registry publishing is now part of release automation, not a hand-maintained checklist in a standalone guide.

## Local Verification

Before touching registry-related metadata or workflow logic, run the workflow validation tests from the repo root.

### Jest validation

```bash
npm test -- --runInBand tests/workflows/mcp-registry-workflow.test.ts
```

This covers:

- workflow file existence and YAML validity
- required OIDC permissions
- pinned `mcp-publisher` versioning
- dry-run support
- `server.json` structure
- version alignment between `server.json` and `package.json`
- `server.json` presence in the published package `files` array

### Shell validation

```bash
tests/workflows/test-mcp-registry-workflow.sh
```

This is a second pass that checks the workflow and metadata from the shell side. It is especially useful when you want a quick operator-style validation instead of Jest output.

## Dry Run

The workflow supports a manual dry run through `workflow_dispatch`.

From GitHub Actions:

- open `Publish to MCP Registry`
- click `Run workflow`
- set `dry_run` to `true`

Or from the CLI:

```bash
gh workflow run publish-mcp-registry.yml -f dry_run=true
```

Dry run mode exercises the workflow path without performing a real registry publish.

## Relationship To npm Publishing

MCP Registry publishing is related to npm publishing, but they are not the same step.

- npm publishing makes the package available at `@dollhousemcp/mcp-server`
- MCP Registry publishing makes the server discoverable through the MCP Registry

The current workflow assumes the release process has already produced a valid publishable package and matching metadata.

If npm metadata and MCP Registry metadata drift apart, registry publishing can fail even when npm publishing succeeds.

## Common Failure Points

### Version mismatch

`server.json.version` and `package.json.version` must match.

The package entry in `server.json.packages[].version` must also match the same version.

### Package identifier mismatch

The npm package name in `package.json` must line up with `server.json.packages[].identifier`.

### Missing `server.json` from published files

If `server.json` drops out of `package.json.files`, the workflow may still build locally, but the published package will not contain the metadata the registry expects.

### Unpinned publisher binary

The workflow intentionally pins a specific `mcp-publisher` version and verifies a checksum. Do not loosen that without a deliberate security review.

### Broken OIDC assumptions

The workflow relies on:

- `id-token: write`
- `contents: read`

If those permissions change, the `mcp-publisher login github-oidc` step can fail.

## When To Update This Doc

Update this guide whenever any of these change:

- the shape of `server.json`
- the MCP Registry publish workflow
- the verification test entry points
- the registry authentication mechanism
- the release trigger or dry-run behavior

## Quick Reference

Validate locally:

```bash
npm test -- --runInBand tests/workflows/mcp-registry-workflow.test.ts
tests/workflows/test-mcp-registry-workflow.sh
```

Dry-run the workflow:

```bash
gh workflow run publish-mcp-registry.yml -f dry_run=true
```

Primary files:

- [server.json](../../server.json)
- [.github/workflows/publish-mcp-registry.yml](../../.github/workflows/publish-mcp-registry.yml)
- [tests/workflows/mcp-registry-workflow.test.ts](../../tests/workflows/mcp-registry-workflow.test.ts)
