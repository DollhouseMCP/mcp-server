import { isDialogAvailable, showVerificationDialogAsync } from '@dollhousemcp/safety';
import { SecurityMonitor } from '../security/securityMonitor.js';

export interface IVerificationNotifier {
  /** Fire-and-forget. The code goes to the human through a private child input pipe. */
  showCode(code: string, reason: string): void;
  isAvailable(): boolean;
}

export class VerificationNotifier implements IVerificationNotifier {
  showCode(code: string, reason: string): void {
    // Unattended integration tests exercise the verification flow without opening a desktop dialog.
    if (process.env.DOLLHOUSE_SUPPRESS_VERIFICATION_DIALOG === 'true') return;

    void showVerificationDialogAsync(code, reason, {
      title: 'DollhouseMCP Verification Required',
      icon: 'warning',
      buttons: ['OK'],
    }).then(result => {
      if (result.success || result.error === 'Dialog cancelled') return;
      SecurityMonitor.logSecurityEvent({
        type: 'DANGER_ZONE_TRIGGERED',
        severity: 'MEDIUM',
        source: 'VerificationNotifier.showCode',
        details: result.error ?? 'Verification dialog unavailable',
      });
    }).catch(() => undefined);
  }

  isAvailable(): boolean {
    return isDialogAvailable();
  }
}
