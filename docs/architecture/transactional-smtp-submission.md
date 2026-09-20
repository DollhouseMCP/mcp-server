# Transactional SMTP submission

`NodemailerEmailSender.sendTransactionalEmail` implements a reusable, multipart
submission contract for #2314. It uses the existing SMTP transporter and accepts
only a single validated recipient, a bounded subject, and bounded text/HTML
strings. Caller-supplied attachments, headers, envelope overrides, file paths,
and URL content sources are not forwarded. Message bodies are transient.

The existing magic-link method retains its own content and 15-minute lifetime.
Invitation callers supply the dedicated #2702 template using the persisted
generation's expiry; they must not use `sendMagicLink`.

## Result semantics

- `submitted`: SMTP reports one accepted recipient and no rejected recipients.
  This is not confirmed delivery or account activation.
- `failed`: a known pre-acceptance authentication, DNS, TLS, envelope,
  or explicit SMTP rejection occurred. A deliberate retry may be considered by
  the durable delivery service while it still has the raw credential in memory.
- `unknown`: acceptance cannot be established. In particular, a timeout or lost
  connection during DATA may hide successful submission. Never automatically
  retry; preserve the attempt and offer explicit regeneration when appropriate.

`ECONNECTION` remains unknown even when its command is `CONN`: the pinned
Nodemailer transport uses that command for unexpected socket closure after DATA
as well as for connection setup. It cannot prove that no message was accepted.

Exceptions and SMTP response strings are never returned or logged by this
method. The result contains only fixed states/categories. Nodemailer's
`info.messageId` is the RFC Message-ID, not a provider-assigned delivery ID, so
`providerMessageId` remains null. Provider event correlation requires a future
documented provider-specific contract; opaque SMTP responses are not parsed.

## Integration boundary

Reserve the generation-bound attempt transactionally before invoking this
method, and send only when the reservation grants submission authority. Commit
before network I/O, send once, then persist the sanitized result. If process loss
or result persistence failure follows SMTP submission, preserve uncertainty;
do not reconstruct the credential or resend from a durable queue.

No route, production sender configuration, or live invitation delivery is
enabled by this adapter. Deployment provisioning, health/readiness routes,
provider tracking settings, real fake-server TLS/failure tests, and hosted
validation remain under #2314. No new email provider is introduced.

## Configuration and startup readiness

SMTP remains optional unless `magic-link` is selected. When every credential
setting is absent, `resolveSmtpConfiguration` reports `disabled` so a future
self-hosted invitation flow can offer manual delivery. A partial configuration
fails validation; it never silently downgrades to disabled email. Enabled SMTP
accepts port 587 with mandatory STARTTLS or port 465 with implicit TLS, bounded
authentication values and timeouts, a hostname or IP address, and one plain
sender address. The sender address is NFC-normalized while preserving the SMTP
local-part's case. Octet limits apply both to that exact value and to the IDNA
ASCII domain that Nodemailer places on the SMTP envelope.

Startup verification throws a `SmtpReadinessError` with a fixed category and
remediation message. Authentication, DNS, connection, timeout, TLS, protocol,
and unknown failures can therefore be reported without retaining or returning
the upstream exception, response, host, credentials, or error cause. Selecting
the `magic-link` method continues to require a complete configuration and a
successful startup verification.

References: [Nodemailer SMTP](https://nodemailer.com/smtp),
[message security options](https://nodemailer.com/message), and
[error codes](https://nodemailer.com/errors).
