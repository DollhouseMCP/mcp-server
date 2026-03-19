/**
 * Display service for cross-platform OS dialogs
 *
 * Shows LLM-proof verification dialogs using native OS dialog systems.
 * The dialog content is NOT returned to stdout (LLM cannot see it).
 * Only the button result is returned.
 *
 * @since v1.0.0
 */

import { execSync } from 'child_process';
import { platform } from 'os';

/**
 * Escape shell argument for Unix shells (bash, sh, zsh)
 * SECURITY: Prevents command injection by wrapping in single quotes.
 *
 * This is the standard POSIX shell escaping pattern: the entire argument is
 * wrapped in single quotes, and any embedded single quotes are escaped as '\''.
 * Inside single quotes, ALL characters (including $, `, \, etc.) are literal
 * except for single quote itself — so only ' needs escaping.
 *
 * codeql[js/incomplete-sanitization] — False positive. Single-quote wrapping
 * makes all other special characters inert in POSIX shells. Only the single
 * quote character requires escaping, which this function handles correctly.
 */
function escapeShellArg(arg: string): string {
  // codeql[js/incomplete-sanitization] - Standard POSIX escaping; only ' needs handling inside single quotes
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Escape argument for PowerShell commands
 * SECURITY: Prevents PowerShell command injection and variable expansion
 */
function escapePowerShellArg(arg: string): string {
  return arg.replace(/[`$"\\]/g, '`$&');
}

export interface DialogOptions {
  title?: string;
  icon?: 'info' | 'warning' | 'error';
  buttons?: string[];
}

export interface DialogResult {
  success: boolean;
  buttonClicked?: string;
  error?: string;
}

/**
 * Show a verification dialog with a code that the LLM cannot see
 *
 * The code is displayed in the dialog but NOT returned to stdout.
 * Only the button click result is returned.
 */
export function showVerificationDialog(
  code: string,
  reason: string,
  options: DialogOptions = {}
): DialogResult {
  const title = options.title || 'Verification Required';
  const message = `${reason}\n\nVerification Code: ${code}\n\nEnter this code when prompted.`;

  try {
    const currentPlatform = platform();

    if (currentPlatform === 'darwin') {
      return showMacOSDialog(title, message, options);
    } else if (currentPlatform === 'linux') {
      return showLinuxDialog(title, message, options);
    } else if (currentPlatform === 'win32') {
      return showWindowsDialog(title, message, options);
    } else {
      // Fallback for unsupported platforms - NEVER log the code
      console.error(`[DisplayService] Unsupported platform: ${currentPlatform}`);
      console.error('[DisplayService] Verification required - code hidden for security');
      console.error(`[DisplayService] Reason: ${reason}`);
      return {
        success: false,
        error: `Unsupported platform: ${currentPlatform}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Show dialog on macOS using osascript
 */
function showMacOSDialog(
  title: string,
  message: string,
  options: DialogOptions
): DialogResult {
  try {
    const buttons = options.buttons || ['OK', 'Cancel'];
    const icon = options.icon || 'warning';

    // Map icon to AppleScript icon
    const iconMap: Record<string, string> = {
      info: 'note',
      warning: 'caution',
      error: 'stop',
    };
    const appleIcon = iconMap[icon] || 'caution';

    // Escape message for AppleScript (escape quotes and newlines for AppleScript string)
    const escapedMessage = message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedButtons = buttons.map((b) => b.replace(/"/g, '\\"'));

    const script = `display dialog "${escapedMessage}" with title "${escapedTitle}" with icon ${appleIcon} buttons {"${escapedButtons[1]}", "${escapedButtons[0]}"} default button "${escapedButtons[0]}"`;

    // Execute osascript - will throw if Cancel is clicked
    // SECURITY: Use escapeShellArg to prevent shell injection
    execSync(`osascript -e ${escapeShellArg(script)}`, { // NOSONAR - Intentional: OS dialog via AppleScript, input escaped with escapeShellArg
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], // Don't inherit stdio
    });

    return {
      success: true,
      buttonClicked: buttons[0],
    };
  } catch (error) {
    // User clicked Cancel or error occurred
    return {
      success: false,
      error: 'Dialog cancelled or error occurred',
    };
  }
}

/**
 * Show dialog on Linux using zenity/kdialog/xmessage fallback chain
 */
function showLinuxDialog(
  title: string,
  message: string,
  options: DialogOptions
): DialogResult {
  // Try zenity first (most common)
  try {
    execSync('which zenity', { stdio: 'pipe' }); // NOSONAR - Intentional: Tool detection, no user input
    return showZenityDialog(title, message, options);
  } catch {
    // zenity not found, try kdialog
    try {
      execSync('which kdialog', { stdio: 'pipe' }); // NOSONAR - Intentional: Tool detection, no user input
      return showKDialogDialog(title, message, options);
    } catch {
      // kdialog not found, try xmessage as last resort
      try {
        execSync('which xmessage', { stdio: 'pipe' }); // NOSONAR - Intentional: Tool detection, no user input
        return showXMessageDialog(title, message);
      } catch {
        // No GUI available - fallback to console
        // SECURITY: Do NOT log the message as it may contain verification codes
        console.error('[DisplayService] No GUI dialog available on Linux');
        console.error(`[DisplayService] Title: ${title}`);
        console.error('[DisplayService] Message content hidden for security');
        return {
          success: false,
          error: 'No GUI dialog system available (tried zenity, kdialog, xmessage)',
        };
      }
    }
  }
}

function showZenityDialog(
  title: string,
  message: string,
  options: DialogOptions
): DialogResult {
  try {
    const icon = options.icon || 'warning';
    // SECURITY: Use escapeShellArg to prevent shell injection
    // NOSONAR - Intentional: OS dialog via zenity, all inputs escaped with escapeShellArg
    execSync(
      `zenity --${icon} --title=${escapeShellArg(title)} --text=${escapeShellArg(message)} --no-wrap`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return { success: true, buttonClicked: 'OK' };
  } catch {
    return { success: false, error: 'Dialog cancelled' };
  }
}

function showKDialogDialog(
  title: string,
  message: string,
  options: DialogOptions
): DialogResult {
  try {
    const icon = options.icon || 'warning';
    const iconMap: Record<string, string> = {
      info: '--msgbox',
      warning: '--sorry',
      error: '--error',
    };
    const kdialogIcon = iconMap[icon] || '--sorry';

    // SECURITY: Use escapeShellArg to prevent shell injection
    // NOSONAR - Intentional: OS dialog via kdialog, all inputs escaped with escapeShellArg
    execSync(
      `kdialog ${kdialogIcon} ${escapeShellArg(message)} --title ${escapeShellArg(title)}`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return { success: true, buttonClicked: 'OK' };
  } catch {
    return { success: false, error: 'Dialog cancelled' };
  }
}

function showXMessageDialog(title: string, message: string): DialogResult {
  try {
    const fullMessage = `${title}\n\n${message}`;
    // SECURITY: Use escapeShellArg to prevent shell injection
    // NOSONAR - Intentional: OS dialog via xmessage, input escaped with escapeShellArg
    execSync(`xmessage -center ${escapeShellArg(fullMessage)}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, buttonClicked: 'OK' };
  } catch {
    return { success: false, error: 'Dialog cancelled' };
  }
}

/**
 * Show dialog on Windows using PowerShell
 */
function showWindowsDialog(
  title: string,
  message: string,
  options: DialogOptions
): DialogResult {
  try {
    const buttons = options.buttons || ['OK', 'Cancel'];
    const icon = options.icon || 'warning';

    // Map icon to PowerShell MessageBoxIcon
    const iconMap: Record<string, string> = {
      info: 'Information',
      warning: 'Warning',
      error: 'Error',
    };
    const psIcon = iconMap[icon] || 'Warning';

    // SECURITY: Escape message and title for PowerShell single-quoted strings
    // Single quotes in PowerShell are escaped by doubling them
    const escapedMessage = message.replace(/'/g, "''");
    const escapedTitle = title.replace(/'/g, "''");

    // Build the PowerShell script using single-quoted strings (safest)
    const script = `Add-Type -AssemblyName System.Windows.Forms; $result = [System.Windows.Forms.MessageBox]::Show('${escapedMessage}', '${escapedTitle}', 'OKCancel', '${psIcon}'); exit ($result -eq 'OK' ? 0 : 1)`;

    // SECURITY: Use -EncodedCommand for safe execution (Base64 encoding prevents injection)
    // NOSONAR - Intentional: OS dialog via PowerShell, input Base64-encoded to prevent injection
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    execSync(`powershell -EncodedCommand ${encodedScript}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      success: true,
      buttonClicked: buttons[0],
    };
  } catch {
    return {
      success: false,
      error: 'Dialog cancelled',
    };
  }
}

/**
 * Check if dialogs are available on current platform
 */
export function isDialogAvailable(): boolean {
  try {
    const currentPlatform = platform();

    if (currentPlatform === 'darwin') {
      // macOS always has osascript
      return true;
    } else if (currentPlatform === 'linux') {
      // Check for any Linux dialog tool
      // NOSONAR - All execSync calls below are intentional tool detection with no user input
      try {
        execSync('which zenity', { stdio: 'pipe' });
        return true;
      } catch {
        try {
          execSync('which kdialog', { stdio: 'pipe' });
          return true;
        } catch {
          try {
            execSync('which xmessage', { stdio: 'pipe' });
            return true;
          } catch {
            return false;
          }
        }
      }
    } else if (currentPlatform === 'win32') {
      // Windows always has PowerShell
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
