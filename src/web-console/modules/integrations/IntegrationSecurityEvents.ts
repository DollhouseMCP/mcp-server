import type { UserIntegrationProvider } from '../../stores/IUserIntegrationStore.js';

export type IntegrationCallbackRejectedReason =
  | 'user_mismatch'
  | 'session_mismatch'
  | 'expired'
  | 'consumed'
  | 'missing';

export interface IntegrationCallbackRejectedEvent {
  readonly type: 'console.auth.integration_callback_rejected.v1';
  readonly userId: string | null;
  readonly provider: UserIntegrationProvider;
  readonly reason: IntegrationCallbackRejectedReason;
  readonly occurredAt: Date;
}

export interface IIntegrationSecurityEventSink {
  recordIntegrationCallbackRejected(event: IntegrationCallbackRejectedEvent): Promise<void>;
}
