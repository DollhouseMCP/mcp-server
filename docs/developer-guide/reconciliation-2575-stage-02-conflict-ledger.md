# Hosted Reconciliation Stage 2 Conflict Ledger

This ledger records the credential-strategy and token-refresh milestone stacked
on Stage 1 under issue #2575.

## Frozen Inputs

- Stage 1 parent: `7e6e752876ea38b97e8b839f2c44e3b7238dbea2`
- Hosted milestone: `4cec8b52470a5025563a11652329adc6b69e7112`
- Hosted commit author: Dibble
- Hosted commit subject: `feat(web-console): add configured credential strategies and token refresh`

The milestone is merged with `--no-ff`. The original hosted commit object remains
an ancestor and is not squashed, rebased, or reconstructed.

## Beta Refresh

- Beta parent: `53bc560d376b20ebde7ff8f69c743ba5cc8f4297`
- Refresh merge: `900c46ba7c3fb5a48099918c79885d6dd5282951`

Current `beta` was merged into the component branch with `--no-ff` after the
outbound-security foundation landed in PR #2587. The merge completed without
conflicts. A direct comparison confirmed that the outbound security and IP
classification files in this branch match `beta`; the older stacked foundation
did not replace the reviewed implementation.

## Conflict Resolution

### `src/web-console/modules/integrations/IntegrationProvider.ts`

Retained Stage 1's fail-closed Unicode validation for GitHub write permission
while accepting the hosted milestone's generalized `IntegrationStatusDto` return
type and credential-strategy contracts.

### `src/web-console/modules/integrations/IntegrationService.ts`

Accepted the hosted milestone's `badRequest()` helper for static credentials,
retained Stage 1's structured integration security logging helper, and preserved
beta's constant-time `timingSafeEqual()` state comparison.

## Scope Boundary

This stage adds configured OAuth/static-key provider strategies and refresh-token
rotation. It does not include the later request gateway, gatekeeper, OpenAPI
operations, or promoted MCP tools.

Validation also added explicit Unicode normalization for human-readable provider
labels while preserving opaque OAuth values byte-for-byte, plus structured outcome
auditing for every token-refresh result and thrown failure. Follow-up review also
aligned revocation with the configured OAuth client-auth mode, retained
provider-returned scopes, and added refresh-failure and mixed-strategy route tests.
