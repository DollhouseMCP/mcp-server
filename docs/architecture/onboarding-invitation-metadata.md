# Restricted invitation metadata

`PostgresOnboardingMetadataStore` is an unregistered read boundary for the claim
page. Its only inputs are server-derived hashes of managed owner/session cookies.
It offers no invitation-ID or email lookup. The transactional session authority
revalidates the current claim and holds its locks until the projection completes.
Missing, ended, swapped, revoked, superseded or otherwise ineligible contexts
return no metadata; database/authority availability failures propagate.

The explicit DTO contains the proved invitation email, intended account name and
roles, email-verification time, separate invitation/session expirations, and the
database clock for relative display. It omits internal IDs, credential material,
hashes, provider details, audit fields and information about other accounts.
The read neither consumes credentials nor extends or rotates a session.

A separate HTTP slice must derive cookie hashes, return this DTO only after proof,
apply no-store/no-referrer and the existing same-origin browser boundary, and
render values as text. Role descriptions come from the shared server role catalog.
The missing-context response remains neutral; this slice does not reveal terminal
invitation state to an unauthenticated lookup or enable a live route.
