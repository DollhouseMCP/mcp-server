/**
 * Display service for cross-platform OS dialogs
 *
 * Shows LLM-proof verification dialogs using native OS dialog systems.
 * The dialog content is NOT returned to stdout (LLM cannot see it).
 * Only the button result is returned.
 *
 * @since v1.0.0
 */

import { execFile, execFileSync, execSync } from 'child_process';
import { platform } from 'os';
import { promisify } from 'util';

const MACOS_DIALOG_SCRIPT = `on run argv
  set dialogTitle to item 1 of argv
  set dialogMessage to item 2 of argv
  set cancelButton to item 3 of argv
  set confirmButton to item 4 of argv
  set dialogIcon to item 5 of argv

  if dialogIcon is "note" then
    display dialog dialogMessage with title dialogTitle with icon note buttons {cancelButton, confirmButton} default button confirmButton
  else if dialogIcon is "stop" then
    display dialog dialogMessage with title dialogTitle with icon stop buttons {cancelButton, confirmButton} default button confirmButton
  else
    display dialog dialogMessage with title dialogTitle with icon caution buttons {cancelButton, confirmButton} default button confirmButton
  end if
end run`;

const runNativeDialog = promisify(execFile);
const RESET_TITLE = 'Reset blocked-agent state';
const RESET_TEXT = 'Reset the unavailable blocked-agent file? The damaged file will be kept as evidence.';
const BASIC_TEXT = 'Basic approval protects against agents limited to MCP tools.';
const PROOF_TEXT = 'Enter a current authenticator code or a backup code.';
const RESET_BUTTON = 'Reset';
const MACOS_RESET_SCRIPT = `on run argv
  set dialogTitle to item 1 of argv
  set dialogMessage to item 2 of argv
  set timeLimit to (item 3 of argv) as integer
  if item 4 of argv is "proof" then
    set reply to display dialog dialogMessage with title dialogTitle buttons {"Cancel", "Reset"} default button "Cancel" cancel button "Cancel" default answer "" with hidden answer giving up after timeLimit
  else
    set reply to display dialog dialogMessage with title dialogTitle buttons {"Cancel", "Reset"} default button "Cancel" cancel button "Cancel" giving up after timeLimit
  end if
  if gave up of reply then return "timeout"
  if button returned of reply is not "Reset" then return "cancel"
  if item 4 of argv is "proof" then return "reset" & linefeed & text returned of reply
  return "reset"
end run`;

const WINDOWS_RESET_SCRIPT = `$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive) { exit 2 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = 'Reset blocked-agent state'
$form.ClientSize = New-Object Drawing.Size(450, 155)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MinimizeBox = $false
$form.MaximizeBox = $false
$form.TopMost = $true
$label = New-Object Windows.Forms.Label
$label.Location = New-Object Drawing.Point(14, 12)
$label.Size = New-Object Drawing.Size(422, 58)
$label.Text = 'Reset the unavailable blocked-agent file? The damaged file will be kept as evidence.' + [Environment]::NewLine
$form.Controls.Add($label)
$proof = $env:DOLLHOUSE_NATIVE_RESET_PROOF -eq '1'
$inputBox = New-Object Windows.Forms.TextBox
if ($proof) {
  $label.Text += 'Enter a current authenticator code or a backup code.'
  $inputBox.Location = New-Object Drawing.Point(14, 75)
  $inputBox.Width = 422
  $inputBox.MaxLength = 64
  $inputBox.UseSystemPasswordChar = $true
  $form.Controls.Add($inputBox)
} else {
  $label.Text += 'Basic approval protects against agents limited to MCP tools.'
}
$cancel = New-Object Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object Drawing.Point(270, 115)
$cancel.DialogResult = 'Cancel'
$form.Controls.Add($cancel)
$reset = New-Object Windows.Forms.Button
$reset.Text = 'Reset'
$reset.Location = New-Object Drawing.Point(353, 115)
$reset.DialogResult = 'OK'
$form.Controls.Add($reset)
$form.AcceptButton = $cancel
$form.CancelButton = $cancel
$form.ActiveControl = $cancel
try {
  if ($form.ShowDialog() -ne 'OK') { [Console]::Out.Write('cancel'); exit 0 }
  [Console]::Out.Write('reset')
  if ($proof) { [Console]::Out.Write([Environment]::NewLine + $inputBox.Text) }
} finally { $form.Dispose() }`;

export type BlockResetDialogResult =
  | { confirmed: true; code?: string }
  | { confirmed: false; reason: 'cancelled' | 'timeout' | 'unavailable' };

function parseResetResponse(stdout: string, requireCode: boolean): BlockResetDialogResult {
  const [action, code, extra] = stdout.trim().split(/\r?\n/u);
  if (action === 'timeout') return { confirmed: false, reason: 'timeout' };
  if (action !== 'reset' || extra !== undefined) return { confirmed: false, reason: 'cancelled' };
  if (!requireCode && code === undefined) return { confirmed: true };
  return code ? { confirmed: true, code } : { confirmed: false, reason: 'cancelled' };
}

/** Request explicit user consent. Proof travels only through the child output pipe. */
export async function showBlockResetDialog(requireCode: boolean, timeoutMs: number): Promise<BlockResetDialogResult> {
  if (timeoutMs <= 0) return { confirmed: false, reason: 'timeout' };
  const timeout = Math.ceil(timeoutMs / 1000);
  const message = `${RESET_TEXT}\n\n${requireCode ? PROOF_TEXT : BASIC_TEXT}`;
  const options = { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4096, windowsHide: true } as const;
  try {
    switch (platform()) {
      case 'darwin': {
        const { stdout } = await runNativeDialog('/usr/bin/osascript', [
          '-e', MACOS_RESET_SCRIPT, '--', RESET_TITLE, message, String(timeout), requireCode ? 'proof' : 'basic',
        ], options);
        return parseResetResponse(stdout, requireCode);
      }
      case 'linux':
        return await showZenityReset(message, requireCode, options);
      case 'win32': {
        const script = Buffer.from(WINDOWS_RESET_SCRIPT, 'utf16le').toString('base64');
        const { stdout } = await runNativeDialog('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', script,
        ], { ...options, env: { ...process.env, DOLLHOUSE_NATIVE_RESET_PROOF: requireCode ? '1' : '0' } });
        return parseResetResponse(stdout, requireCode);
      }
      default:
        return { confirmed: false, reason: 'unavailable' };
    }
  } catch (error) {
    const failure = error as { code?: number; killed?: boolean; stderr?: string };
    if (failure.killed || failure.code === 5) return { confirmed: false, reason: 'timeout' };
    if ((failure.code === 1 && !failure.stderr?.trim()) || failure.stderr?.includes('(-128)')) {
      return { confirmed: false, reason: 'cancelled' };
    }
    // Process diagnostics can contain user input. Never relay stdout or stderr.
    return { confirmed: false, reason: 'unavailable' };
  }
}

async function showZenityReset(
  message: string, requireCode: boolean, options: { encoding: 'utf8'; timeout: number; maxBuffer: number },
): Promise<BlockResetDialogResult> {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { confirmed: false, reason: 'unavailable' };
  const deadline = performance.now() + options.timeout;
  let code: string | undefined;
  if (requireCode) {
    const { stdout } = await runNativeDialog('zenity', [
      '--entry', '--hide-text', '--title', RESET_TITLE, '--text', PROOF_TEXT,
    ], options);
    code = stdout.trim();
    if (!code) return { confirmed: false, reason: 'cancelled' };
  }
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) return { confirmed: false, reason: 'timeout' };
  await runNativeDialog('zenity', [
    '--question', '--default-cancel', '--no-markup', '--title', RESET_TITLE,
    '--text', message, '--ok-label', RESET_BUTTON, '--cancel-label', 'Cancel',
  ], { ...options, timeout: remaining });
  return code ? { confirmed: true, code } : { confirmed: true };
}

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

    // Keep untrusted display values out of AppleScript source. Passing them as
    // argv also avoids invoking a shell, so neither language can reinterpret them.
    execFileSync('/usr/bin/osascript', [
      '-e',
      MACOS_DIALOG_SCRIPT,
      '--',
      title,
      message,
      buttons[1],
      buttons[0],
      appleIcon,
    ], {
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
