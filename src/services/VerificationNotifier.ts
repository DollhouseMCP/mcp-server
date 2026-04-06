/**
 * VerificationNotifier - Non-blocking OS dialog for verification codes (Issue #522)
 *
 * Spawns native OS dialogs to display verification codes directly to the human.
 * The code is NEVER returned to the LLM via MCP tool responses.
 *
 * Why a separate service instead of reusing DisplayService?
 * - DisplayService uses execSync (blocking). We need non-blocking spawn so
 *   the MCP response returns immediately.
 * - DI-injectable for testability (integration tests run headless, can mock/spy).
 * - Clean separation: DisplayService owns cross-platform dialog mechanics,
 *   VerificationNotifier owns the "fire-and-forget, never block the server" concern.
 *
 * @since v1.1.0
 */

import { spawn, execSync } from 'child_process';
import { platform } from 'os';
import { SecurityMonitor } from '../security/securityMonitor.js';

/**
 * Interface for verification code display.
 * Implementations must NEVER return or log the code itself.
 */
export interface IVerificationNotifier {
  /** Fire-and-forget: show the code in an OS dialog. Never throws. */
  showCode(code: string, reason: string): void;
  /** Whether the current platform supports OS dialogs. */
  isAvailable(): boolean;
}

export class VerificationNotifier implements IVerificationNotifier {
  /**
   * Display the verification code via a native OS dialog.
   *
   * - Uses child_process.spawn with detached + unref for true fire-and-forget
   * - Never throws (catches all errors internally)
   * - Never logs the code itself
   */
  showCode(code: string, reason: string): void {
    let currentPlatform = 'unknown';
    try {
      currentPlatform = platform();
      const title = 'DollhouseMCP Verification Required';
      // The message shown to the human in the dialog
      const message = `${reason}\n\nVerification Code: ${code}\n\nType this code in your chat to proceed.`;

      if (currentPlatform === 'darwin') {
        this.spawnMacOS(title, message);
      } else if (currentPlatform === 'linux') {
        this.spawnLinux(title, message);
      } else if (currentPlatform === 'win32') {
        this.spawnWindows(title, message);
      } else {
        // SECURITY: Never log the code on unsupported platforms
        SecurityMonitor.logSecurityEvent({
          type: 'DANGER_ZONE_TRIGGERED',
          severity: 'MEDIUM',
          source: 'VerificationNotifier.showCode',
          details: `Unsupported platform for verification dialog: ${currentPlatform}`,
          additionalData: { platform: currentPlatform },
        });
      }
    } catch {
      // SECURITY: Never log the code in error paths
      SecurityMonitor.logSecurityEvent({
        type: 'DANGER_ZONE_TRIGGERED',
        severity: 'MEDIUM',
        source: 'VerificationNotifier.showCode',
        details: 'Failed to spawn verification dialog',
        additionalData: { platform: currentPlatform },
      });
    }
  }

  isAvailable(): boolean {
    try {
      const currentPlatform = platform();

      if (currentPlatform === 'darwin') {
        return true; // macOS always has osascript
      } else if (currentPlatform === 'linux') {
        return this.hasLinuxDialogTool();
      } else if (currentPlatform === 'win32') {
        return true; // Windows always has PowerShell
      }

      return false;
    } catch {
      return false;
    }
  }

  // ---- Platform-specific spawners ----

  private spawnMacOS(title: string, message: string): void {
    // Escape for AppleScript: backslashes, then double quotes. Newlines are
    // replaced with AppleScript `return` character concatenation so they render
    // as real line breaks in the dialog instead of literal "\n" text.
    const escapedTitle = title.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(/[\n\r]/g, ' ');
    const escapedMessage = message.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    // Split on newlines and join with AppleScript return concatenation
    const messageParts = escapedMessage.split(/\r?\n/).map(part => `"${part}"`).join(' & return & ');

    const script = `display dialog (${messageParts}) with title "${escapedTitle}" with icon caution buttons {"OK"} default button "OK"`;

    // NOSONAR - Intentional: OS dialog via AppleScript, input escaped with escapeShellArg
    const child = spawn('osascript', ['-e', script], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  private spawnLinux(title: string, message: string): void {
    const realMessage = message;

    try {
      execSync('which zenity', { stdio: 'pipe' }); // NOSONAR - Tool detection, no user input
      const child = spawn('zenity', [
        '--info',
        `--title=${title}`,
        `--text=${realMessage}`,
        '--no-wrap',
      ], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    } catch { /* zenity not found */ }

    try {
      execSync('which kdialog', { stdio: 'pipe' }); // NOSONAR - Tool detection, no user input
      const child = spawn('kdialog', [
        '--msgbox', realMessage,
        '--title', title,
      ], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    } catch { /* kdialog not found */ }

    try {
      execSync('which xmessage', { stdio: 'pipe' }); // NOSONAR - Tool detection, no user input
      const child = spawn('xmessage', [
        '-center', `${title}\n\n${realMessage}`,
      ], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    } catch { /* xmessage not found */ }

    // No dialog tool available
    SecurityMonitor.logSecurityEvent({
      type: 'DANGER_ZONE_TRIGGERED',
      severity: 'MEDIUM',
      source: 'VerificationNotifier.spawnLinux',
      details: 'No GUI dialog tool available on Linux (tried zenity, kdialog, xmessage)',
      additionalData: { platform: 'linux', dialogToolsTried: ['zenity', 'kdialog', 'xmessage'] },
    });
  }

  private spawnWindows(title: string, message: string): void {
    // Convert real newlines to PowerShell backtick-n for MessageBox rendering
    const realMessage = message.replaceAll('\n', '`n');
    const escapedMessage = realMessage.replaceAll("'", "''");
    const escapedTitle = title.replaceAll("'", "''");

    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${escapedMessage}', '${escapedTitle}', 'OK', 'Warning')`;

    // SECURITY: Use -EncodedCommand for safe execution (Base64 encoding prevents injection)
    // NOSONAR - Intentional: OS dialog via PowerShell, input Base64-encoded
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell', ['-EncodedCommand', encodedScript], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  private hasLinuxDialogTool(): boolean {
    // NOSONAR - All execSync calls below are tool detection with no user input
    try {
      execSync('which zenity', { stdio: 'pipe' });
      return true;
    } catch { /* not found */ }
    try {
      execSync('which kdialog', { stdio: 'pipe' });
      return true;
    } catch { /* not found */ }
    try {
      execSync('which xmessage', { stdio: 'pipe' });
      return true;
    } catch { /* not found */ }
    return false;
  }
}
