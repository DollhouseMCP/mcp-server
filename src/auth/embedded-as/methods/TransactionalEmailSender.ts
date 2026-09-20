/** Transient message bodies must never enter logs, audit records, or durable queues. */
export interface TransactionalEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export type EmailSubmissionFailure = 'authentication' | 'connection' | 'tls' | 'rejected' | 'indeterminate';

export type EmailSubmissionResult =
  | { readonly state: 'submitted'; readonly providerMessageId: string | null }
  | { readonly state: 'failed'; readonly failureClass: Exclude<EmailSubmissionFailure, 'indeterminate'> }
  | { readonly state: 'unknown'; readonly failureClass: 'indeterminate' };

/** Submission is SMTP acceptance, not inbox delivery. No automatic retries. */
export interface TransactionalEmailSender {
  sendTransactionalEmail(message: TransactionalEmail): Promise<EmailSubmissionResult>;
}

/** Only outcomes known to precede acceptance permit a later deliberate retry. */
export function classifyEmailSubmissionFailure(error: unknown): EmailSubmissionResult {
  const candidate = error as { code?: unknown; command?: unknown; responseCode?: unknown } | null;
  switch (candidate?.code) {
    case 'EAUTH': return { state: 'failed', failureClass: 'authentication' };
    case 'EDNS': return { state: 'failed', failureClass: 'connection' };
    case 'ETLS': return { state: 'failed', failureClass: 'tls' };
    case 'EENVELOPE': return { state: 'failed', failureClass: 'rejected' };
  }
  if (typeof candidate?.responseCode === 'number'
      && Number.isInteger(candidate.responseCode)
      && candidate.responseCode >= 400 && candidate.responseCode <= 599
      && typeof candidate.command === 'string'
      && ['MAIL FROM', 'RCPT TO', 'DATA'].includes(candidate.command)) {
    return { state: 'failed', failureClass: 'rejected' };
  }
  // ECONNECTION (even command CONN in Nodemailer) can mean the socket closed
  // after DATA. Neither the code nor that command proves pre-acceptance failure.
  // A lost connection/timeout during DATA may hide successful acceptance.
  // Do not retain provider responses, exception messages, or causes.
  return { state: 'unknown', failureClass: 'indeterminate' };
}
