# Proposed Node 24 Trixie container remediation

Tracks [#3064](https://github.com/DollhouseMCP/mcp-server/issues/3064), based on beta `f535d279cbfe7ac65509c3db5afcd59c822025c0`. This proposed image update is not security approval, an age exception, merge approval or deployment permission. Global npm tooling and the application SDK have separate remediation work.

Both production Dockerfiles use one shared `node-base` stage so builder/migrations, production dependency preparation and final runtime receive the same supported stable security packages. Node remains **24.21.0**. Existing runtime commands, UID1001, private v2 drain, guard-OFF behavior, portfolios, keys and schema62 are unchanged. The safety development dependency tree must remain absent from every final image layer; the complete builder is retained.

## Exact source and proposed pins

The official Docker registry observation on October14 resolved `node:24.21.0-trixie-slim` to:

| Object | SHA256 |
| --- | --- |
| Multi-platform index | `173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66` |
| Linux amd64 manifest | `c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63` |
| Linux arm64 manifest | `f78037e2794cbe13ccef68c8a3cdca5c263c27ff6d747617cb87206daf4d12a0` |

The returned index/child/config bytes were independently hashed against those descriptors. The official [image definitions](https://github.com/docker-library/official-images/blob/master/library/node) bind Node24.21.0 Trixie-slim to nodejs/docker-node commit `93a7bafc324a85ac1ee461604cff87cffacb6d7a`; its [Dockerfile](https://github.com/nodejs/docker-node/blob/93a7bafc324a85ac1ee461604cff87cffacb6d7a/24/trixie-slim/Dockerfile) uses Debian Trixie and the signed official Node distribution. Exact index registry publication is October6, 2026 at05:40:39UTC, fewer than21days ago; [#2452](https://github.com/DollhouseMCP/mcp-server/issues/2452) requires an explicit exception before adoption.

| Stable package pin | Fix scope | Available age evidence |
| --- | --- | --- |
| `libc6`, `libc-bin` `2.41-12+deb13u4` | Debian fixes for scanf/ungetwc and related glibc findings | SHA-verified Debian package changelog June29; repository file modified July11 |
| `perl-base` `5.40.1-6+deb13u1` | Available Debian Perl fixes, including five prior Critical scanner rows | SHA-verified changelog August30; repository file modified September3 |
| `openssl`, `libssl3t64`, `openssl-provider-legacy` `3.5.7-1~deb13u3` | Debian security backport for DTLS stale-buffer retransmission | SHA-verified package changelog/repository file September29, fewer than21days; exception required |

Changelog/file dates are provenance evidence, not an invented exact registry-publication timestamp. Complete installed old/new package inventories and any additional young-package questions must be reviewed against the final image. No unstable/sid libraries are mixed into Trixie. Exact pins fail when unavailable; they do not silently fall back or upgrade to unrelated releases.

## Qualification and residuals

Actual new image builds, installed versions, native addon imports, default-OFF startup, private drain/restart witness, storage/recovery compatibility, all-layer checks and fresh scans are pending. Existing beta/Bookworm image results do not qualify the new image. Preserve the raw70High/7Critical baseline; no scanner suppression or promised clean result. Base refresh can fix available vendor issues but does not by itself remediate global npm/SDK or establish remaining GCC/zlib applicability.

Rollback source is the exact beta parent with its previous immutable image, subject to the existing no-loss and no-post-reopen-restore restrictions. This source-only proposal does not authorize any live signal, service change or rollback.
