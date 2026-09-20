# Invitation email template and claim link

This pure rendering slice of #2314 produces HTML and plain text with a fixed
subject. It does not send email, modify SMTP configuration, mount a claim route,
create accounts, or activate invitations. Role labels/descriptions come from the
caller's human-facing catalog (#2670); no internal capability identifiers belong
in the template input.

The caller supplies the persisted generation's issued/expiry timestamps. The
email shows the exact expiration in UTC and the original lifetime in hours
(1–168). It never reads the generic sign-in magic-link TTL. The template is a
renderer, not an expiry/authorization check; the future send flow must reserve a
current valid generation immediately before submission.

## Claim-link contract with #2680

`INVITATION_CLAIM_PATH` is `/auth/onboarding/invitation`. The builder accepts only
the configured trusted HTTPS origin, with an optional trailing slash and port.
It rejects userinfo, query strings, fragments, subpaths, dot paths, backslashes,
encoded hosts and surrounding whitespace. Do not derive this value from HTTP
Host/Forwarded headers. Reverse proxies serving a subpath must explicitly expose
the fixed path at the trusted origin; caller-controlled redirects are unsupported.

The link is `/auth/onboarding/invitation#token=<credential>`. The credential is
in the fragment so it is absent from the initial HTTP request target and normal
server/proxy access logs. It still exists in the email body and in the recipient's
browser; fragments are not a substitute for careful client-side handling.

The future claim page must:

- Read and validate the fragment, then promptly remove it with history replacement.
- Hold the credential only in memory, without local/session storage or analytics.
- Exchange it via POST only after explicit user action. GET, preview and email
  scanner/prefetch requests must never consume an invitation.
- Use no-referrer and no-store protections and exclude third-party scripts.
- Establish the restricted onboarding session before GitHub linking; the link
  alone never provides normal console/MCP authorization or activation.

## Transport integration

Todd's existing `NodemailerEmailSender` already owns SMTP/TLS configuration and
startup verification. Its current `sendMagicLink` method deliberately renders a
separate 15-minute sign-in message; do not call that method for invitations.
The later invitation-send adapter should reuse that configured transport and
supply this renderer's `subject`, `text`, and `html` to one multipart message.
No third provider or SMTP network operation is introduced here.

The envelope/header sender must remain the operator-configured, verified
`DOLLHOUSE_SMTP_FROM`. `supportEmail` is body content only: it does not override
From or Reply-To. This slice adds no Reply-To header; any later reply address must
be explicitly configured and validated in the transport adapter.

The rendered bodies and fragment URL contain the one-time credential. They may
exist only transiently during the winning issue/regenerate/send call; never log,
cache, persist, put them in provider metadata, or pass them through generic
idempotency-response storage. Disable provider click/open tracking and URL
rewriting when integrating the transport. The template itself has no remote
images, scripts, tracking pixels, stylesheets or analytics.

A lost response or crash requires explicit regeneration, not reconstruction of
a raw token. New generations invalidate older links. SMTP acceptance remains
`submitted`, not confirmed delivery. #2691 owns reservation/outcome bookkeeping,
and #2680/#2681 own restricted claim and atomic activation.

Support mailbox validation preserves local-part casing and normalizes only the
domain casing; operator contact addresses are not recipient identity keys.
