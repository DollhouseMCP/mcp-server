# Build and test dependency candidate — 2026-10-14

This candidate addresses the development dependencies tracked by #3071. It does
not change application handlers or Dockerfiles, and the complete production
dependency lock map is unchanged. Package/lock and build inputs do change, so
future builder graphs and image bytes can differ. Actual combined build/output
correspondence requires separate qualification.

| Dependency | Candidate | Actual repository consumer |
| --- | --- | --- |
| `@babel/core` | 7.29.6 | Jest/Babel transforms, including input source maps |
| `@humanfs/node` | 0.16.8 | ESLint filesystem implementation; its vulnerable copy APIs are tested directly |
| `handlebars` | 4.7.10 | ts-jest's explicit `config:init` command compiles a fixed configuration template |
| `@esbuild-kit/core-utils` → `esbuild` | 0.25.12 | Existing TypeScript loader and Drizzle tooling |

Handlebars is **not** a coverage-report or application template consumer here.
The fixed ts-jest template does not establish an attacker-controlled template
path. These development audit findings alone do not establish a production
deployment blocker.

## Resolution and provenance

Both the root and independent safety-workspace locks are updated. Babel's
required closure adds 16 Babel releases, and humanfs adds its node/core/types
releases. Together with Handlebars, these are 20 new package versions. Every new
tarball was checked against registry SHA-512 integrity and registry ECDSA
signatures; publication timestamps were recorded. The youngest aged Babel
closure member is parser 7.29.9, published September 18. Explicit helper/traverse
pins avoid unrelated October releases; `update-browserslist-db` stays at the
existing 1.2.3 version.

Handlebars 4.7.10 was published October 5 at 22:37:37.837 UTC. It is younger than
21 days and remains a candidate pending a **new, explicit age exception**.
Its tarball SHA-256 is
`14f356e6cadb5b064a156d2b39dd843abba8f4b1a38ee036935adecc1a13ad9f`.
Earlier approvals for SDK, Node-image, or OpenSSL artifacts do not cover it.

The esbuild override is scoped to `@esbuild-kit/core-utils`. It reuses the
existing 0.25.12 artifact and platform-package family already locked beneath
Drizzle. It deliberately crosses core-utils' declared `~0.18.20` range, so the
consumer tests below are required compatibility evidence. The root esbuild
0.27.2 and Drizzle's existing 0.25.12 versions are preserved. No resolver or
package-install lifecycle scripts are enabled by the lock update.

## Checked behavior

The normal Jest suite includes ten regression and consumer cases:

- Babel excludes an external source-map payload and preserves an in-package map.
- humanfs preserves symlinks in both copy APIs and copies ordinary files.
- Handlebars escapes inline script terminators, rejects malformed AST block
  parameters, blocks prototype constructor access, and retains legitimate text,
  own properties, and AST rendering.
- core-utils retains sync/async TypeScript transforms, source maps, and warnings.
- The actual ts-jest `config:init`, ESM TypeScript loader, and offline Drizzle
  PostgreSQL migration generator execute successfully in owned temporary roots.

The old installed Babel 7.28.3, humanfs 0.16.7, and Handlebars 4.7.9 were matched
to their signed published file contents. All six corresponding old security
properties failed using benign fixture strings and files. No injected code was
executed. These checks demonstrate the tested fixes, not the absence of all
vulnerabilities or compatibility with every possible template or build input.

Local checks used Node 24.16.0 and verified npm 11.19.0. The ten focused cases,
the owned safety-workspace build, root build, and precommit's 108 tests passed.
Precommit still exits 1 on its dependency audit. Full lint retains two unchanged
process/startup-fixture errors outside this patch; the new test passes its
targeted lint check.

The broader local unit run is retained as **17,956 passed / 23 failed**. Twenty-two
failures hit Unix socket pathname limits in the private temporary environment;
all 22 pass with a short owned temporary root. Four existing controls selected
by the same targeted suite pattern also pass. The remaining font-asset test
returns 404. A source-supported venue explanation is that its unchanged absolute
`sendFile` path contains the isolated worktree's `.codex` segment, which the
unchanged `send` package's default dotfile policy ignores; the exact request was
not instrumented to isolate that cause. The actual built resource exists and
resolves correctly. This is not a full-suite pass or a deployed-runtime finding;
fresh isolated CI remains necessary. No test deadline or production policy was
changed to obtain these results.

Same-day lock-only audits against beta `f535d279` report 60 → 56 root package
vulnerability entries and 43 → 41 in the independent safety workspace. All six
targeted direct advisory IDs disappear; none is added. These totals include
transitive metavulnerability propagation and are not unique advisory counts.
The installed candidate audit reports 53 entries, with the same direct advisory
IDs as its lock-only audit; its graph omits three propagated app entries. These
remaining application/tooling findings are outside this candidate's four
families and remain recorded, including unchanged braces and sprintf-js.

## Limits

The original build prerequisites and audit failures are retained in private
qualification evidence. Full-source audit still includes unresolved findings;
braces and sprintf-js have no official patched release in the examined primary
records. This candidate does not invent replacement versions or remove their
feature callers. Fresh CI and final independent review remain required. No
deployment, merge, or security-exception approval is implied by this document.
