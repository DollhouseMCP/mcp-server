# Hosted Reconciliation Stage 1 Conflict Ledger

This ledger records the first ancestry-preserving hosted HTTP milestone merged into
the repaired `beta` branch under issue #2575.

## Frozen Inputs

- Beta parent: `27b906f721d11b09ffb99f3fbabbf8a8d4043ae3`
- Hosted milestone: `e69813f011a525dd9662cc2db572f1a1a3ad215a`
- Hosted commit author: Dibble
- Hosted commit subject: `feat(web-console): generalize integration provider seam and storage`

The milestone was merged with `--no-ff`. The original hosted commit object remains
an ancestor of this branch; it was not squashed, rebased, or reconstructed.

## Conflict Resolution

### `src/web-console/modules/integrations/IntegrationService.ts`

The hosted milestone generalized credential revocation from a hard-coded GitHub
provider to `active.provider`. Beta independently hardened `decryptNullable()` by
requiring the expected user and provider as additional binding arguments.

The resolution retains both behaviors:

- Build access-token and refresh-token encryption contexts with `active.provider`.
- Pass `auth.userId` and `active.provider` to `decryptNullable()` so ciphertext is
  rejected when its embedded principal or provider does not match the request.

No other textual conflicts occurred in this stage.

## Beta Compatibility Patch

Validation against the current beta branch exposed three assumptions that the
original hosted commit could safely make at its older base but not at this one:

- Integration success audit data now records the generic provider and permission
  projection instead of reaching through the generic result for GitHub-only fields.
- Credential-decryption audit binding accepts the generalized provider type while
  retaining beta's expected-user and expected-provider checks.
- GitHub write permission selection normalizes Unicode but fails closed when the
  normalized value differs from the caller's exact ASCII input.

These changes make this milestone independently buildable and secure on beta;
they do not import later hosted credential strategies or gateway behavior.

## Validation Requirements

- Verify the merge commit has beta and the original hosted milestone as its two
  parents.
- Verify the original hosted commit remains reachable with its author unchanged.
- Run integration module and storage tests affected by the provider generalization.
- Run build, lint, security audit, and the repository CI checks before promotion.
