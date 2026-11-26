/**
 * Display service for cross-platform OS dialogs
 *
 * Shows LLM-proof verification dialogs using native OS dialog systems.
 * The dialog content is NOT returned to stdout (LLM cannot see it).
 * Only the button result is returned.
 *
 * @since v1.0.0
 */

import { execFile, execFileSync, execSync, spawn } from 'child_process';
import { platform } from 'os';
import { promisify } from 'node:util';

const MACOS_DIALOG_SCRIPT = `use framework "Foundation"
use scripting additions
on run argv
  set dialogTitle to item 1 of argv
  set cancelButton to item 2 of argv
  set confirmButton to item 3 of argv
  set dialogIcon to item 4 of argv
  set inputFile to current application's NSFileHandle's fileHandleWithStandardInput()
  set inputData to inputFile's readDataToEndOfFile()
  set dialogMessage to (current application's NSString's alloc()'s initWithData:inputData encoding:(current application's NSUTF8StringEncoding)) as text

  if dialogIcon is "note" then
    display dialog dialogMessage with title dialogTitle with icon note buttons {cancelButton, confirmButton} default button confirmButton
  else if dialogIcon is "stop" then
    display dialog dialogMessage with title dialogTitle with icon stop buttons {cancelButton, confirmButton} default button confirmButton
  else
    display dialog dialogMessage with title dialogTitle with icon caution buttons {cancelButton, confirmButton} default button confirmButton
  end if
end run`;

const WINDOWS_DIALOG_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$dialog = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
$result = [System.Windows.Forms.MessageBox]::Show($dialog.message, $dialog.title, $dialog.buttons, $dialog.icon)
if ($result -eq 'OK') { exit 0 }
exit 1`;

const runNativeDialog = promisify(execFile);
const BASIC_TEXT = 'Basic approval protects against agents limited to MCP tools.';
const PROOF_TEXT = 'Enter a current authenticator code or a backup code.';
const MACOS_APPROVAL_SCRIPT = `use framework "Foundation"
use scripting additions
on run argv
  set dialogTitle to item 1 of argv
  set approveButton to item 2 of argv
  set timeLimit to (item 3 of argv) as integer
  set inputFile to current application's NSFileHandle's fileHandleWithStandardInput()
  set inputData to inputFile's readDataToEndOfFile()
  set dialogMessage to (current application's NSString's alloc()'s initWithData:inputData encoding:(current application's NSUTF8StringEncoding)) as text
  if item 4 of argv is "proof" then
    set reply to display dialog dialogMessage with title dialogTitle buttons {"Cancel", approveButton} default button "Cancel" cancel button "Cancel" default answer "" with hidden answer giving up after timeLimit
  else
    set reply to display dialog dialogMessage with title dialogTitle buttons {"Cancel", approveButton} default button "Cancel" cancel button "Cancel" giving up after timeLimit
  end if
  if gave up of reply then return "timeout"
  if button returned of reply is not approveButton then return "cancel"
  if item 4 of argv is "proof" then return "reset" & linefeed & text returned of reply
  return "reset"
end run`;

const WINDOWS_APPROVAL_SCRIPT = `$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive) { exit 2 }
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$dialog = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = $dialog.title
$form.ClientSize = New-Object Drawing.Size(450, 155)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MinimizeBox = $false
$form.MaximizeBox = $false
$form.TopMost = $true
$label = New-Object Windows.Forms.Label
$label.Location = New-Object Drawing.Point(14, 12)
$label.Size = New-Object Drawing.Size(422, 58)
$label.Text = $dialog.message
$form.Controls.Add($label)
$proof = $dialog.requireCode -eq $true
$inputBox = New-Object Windows.Forms.TextBox
if ($proof) {
  $inputBox.Location = New-Object Drawing.Point(14, 75)
  $inputBox.Width = 422
  $inputBox.MaxLength = 64
  $inputBox.UseSystemPasswordChar = $true
  $form.Controls.Add($inputBox)
}
$cancel = New-Object Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object Drawing.Point(270, 115)
$cancel.DialogResult = 'Cancel'
$form.Controls.Add($cancel)
$reset = New-Object Windows.Forms.Button
$reset.Text = $dialog.approveLabel
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

export type NativeApprovalDialogResult =
  | { confirmed: true; code?: string }
  | { confirmed: false; reason: 'cancelled' | 'timeout' | 'unavailable' };

export type BlockResetDialogResult = NativeApprovalDialogResult;

interface NativeApprovalPrompt {
  title: string;
  summary: string;
  approveLabel: string;
}

type NativeApprovalDialogOptions = { encoding: 'utf8'; timeout: number; maxBuffer: number; windowsHide: boolean };

function parseApprovalResponse(stdout: string, requireCode: boolean): NativeApprovalDialogResult {
  const [action, code, extra] = stdout.trim().split(/\r?\n/u);
  if (action === 'timeout') return { confirmed: false, reason: 'timeout' };
  if (action !== 'reset' || extra !== undefined) return { confirmed: false, reason: 'cancelled' };
  if (!requireCode && code === undefined) return { confirmed: true };
  return code ? { confirmed: true, code } : { confirmed: false, reason: 'cancelled' };
}

export function showBlockResetDialog(requireCode: boolean, timeoutMs: number): Promise<BlockResetDialogResult> {
  return showNativeApprovalDialog({
    title: 'Reset blocked-agent state',
    summary: 'Reset the unavailable blocked-agent file? The damaged file will be kept as evidence.',
    approveLabel: 'Reset',
  }, requireCode, timeoutMs);
}

function runApprovalDialogWithInput(
  command: string, args: string[], options: NativeApprovalDialogOptions, input: string,
) {
  const pending = runNativeDialog(command, args, options);
  const stdin = pending.child?.stdin;
  // A cancellation or failed launch can close stdin before the write finishes.
  // The process result remains the authority on whether the dialog opened.
  stdin?.once('error', () => {});
  stdin?.end(input);
  return pending;
}

/** Request explicit consent. Only the private child output pipe carries authenticator proof. */
export async function showNativeApprovalDialog(
  prompt: NativeApprovalPrompt, requireCode: boolean, timeoutMs: number,
): Promise<NativeApprovalDialogResult> {
  if (timeoutMs <= 0) return { confirmed: false, reason: 'timeout' };
  const timeout = Math.ceil(timeoutMs / 1000);
  const { title, approveLabel, summary } = prompt;
  const message = `${summary}\n\n${requireCode ? PROOF_TEXT : BASIC_TEXT}`;
  const options: NativeApprovalDialogOptions = { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4096, windowsHide: true };
  try {
    switch (platform()) {
      case 'darwin': {
        const { stdout } = await runApprovalDialogWithInput('/usr/bin/osascript', [
          '-e', MACOS_APPROVAL_SCRIPT, '--', title, approveLabel, String(timeout), requireCode ? 'proof' : 'basic',
        ], options, message);
        return parseApprovalResponse(stdout, requireCode);
      }
      case 'linux':
        return await showZenityApproval(prompt, message, requireCode, options);
      case 'win32': {
        const script = Buffer.from(WINDOWS_APPROVAL_SCRIPT, 'utf16le').toString('base64');
        const { stdout } = await runApprovalDialogWithInput('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', script,
        ], options, JSON.stringify({ title, message, approveLabel, requireCode }));
        return parseApprovalResponse(stdout, requireCode);
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

async function showZenityApproval(
  prompt: NativeApprovalPrompt, message: string, requireCode: boolean, options: NativeApprovalDialogOptions,
): Promise<NativeApprovalDialogResult> {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { confirmed: false, reason: 'unavailable' };
  const deadline = performance.now() + options.timeout;
  let code: string | undefined;
  if (requireCode) {
    const { stdout } = await runNativeDialog('zenity', [
      '--entry', '--hide-text', '--title', prompt.title, '--text', PROOF_TEXT,
    ], options);
    code = stdout.trim();
    if (!code) return { confirmed: false, reason: 'cancelled' };
  }
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) return { confirmed: false, reason: 'timeout' };
  await runNativeDialog('zenity', [
    '--question', '--default-cancel', '--no-markup', '--title', prompt.title,
    '--text', message, '--ok-label', prompt.approveLabel, '--cancel-label', 'Cancel',
  ], { ...options, timeout: remaining });
  return code ? { confirmed: true, code } : { confirmed: true };
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

interface VerificationDialogCommand {
  readonly file: string;
  readonly args: string[];
  readonly input: string;
  readonly button: string;
}

const LINUX_DIALOGS = [['zenity', 'which zenity'], ['kdialog', 'which kdialog'], ['xmessage', 'which xmessage']] as const;

function findLinuxDialog(): typeof LINUX_DIALOGS[number][0] | undefined {
  for (const [file, probe] of LINUX_DIALOGS) {
    try {
      execSync(probe, { stdio: 'ignore' }); // NOSONAR - Only the fixed tool probes above.
      return file;
    } catch { /* Try the next installed dialog. */ }
  }
  return undefined;
}

function verificationDialogCommand(code: string, reason: string, options: DialogOptions): VerificationDialogCommand {
  const title = options.title ?? 'Verification Required';
  const [confirm = 'OK', cancel = 'Cancel'] = options.buttons ?? [];
  const icon = options.icon ?? 'warning';
  const message = reason + '\n\nVerification Code: ' + code + '\n\nEnter this code when prompted.';
  const currentPlatform = platform();

  switch (currentPlatform) {
    case 'darwin':
      return {
        file: '/usr/bin/osascript',
        args: ['-e', MACOS_DIALOG_SCRIPT, '--', title, cancel, confirm, { info: 'note', warning: 'caution', error: 'stop' }[icon]],
        input: message,
        button: confirm,
      };
    case 'win32':
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(WINDOWS_DIALOG_SCRIPT, 'utf16le').toString('base64')],
        input: JSON.stringify({
          message, title, buttons: options.buttons?.length === 1 ? 'OK' : 'OKCancel',
          icon: { info: 'Information', warning: 'Warning', error: 'Error' }[icon],
        }),
        button: confirm,
      };
    case 'linux':
      return linuxVerificationCommand(title, message);
    default:
      throw new Error('Unsupported platform: ' + currentPlatform);
  }
}

function linuxVerificationCommand(title: string, message: string): VerificationDialogCommand {
  const file = findLinuxDialog();
  switch (file) {
    case 'zenity':
      return { file, args: ['--text-info', '--title=' + title], input: message, button: 'OK' };
    case 'kdialog':
      return { file, args: ['--textbox', '-', '--title', title], input: message, button: 'OK' };
    case 'xmessage':
      return { file, args: ['-center', '-file', '-'], input: title + '\n\n' + message, button: 'OK' };
    default:
      throw new Error('No GUI dialog system available (tried zenity, kdialog, xmessage)');
  }
}

const VERIFY_DIALOG_STDIO: ['pipe', 'ignore', 'ignore'] = ['pipe', 'ignore', 'ignore'];

function prepareVerificationDialog(code: string, reason: string, options: DialogOptions): VerificationDialogCommand | DialogResult {
  try {
    return verificationDialogCommand(code, reason, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Verification dialog unavailable';
    console.error('[DisplayService] ' + message + '. Message content hidden for security.');
    return { success: false, error: message };
  }
}

/** Display a legacy code using a private child input pipe. Only the button result is returned. */
export function showVerificationDialog(code: string, reason: string, options: DialogOptions = {}): DialogResult {
  const command = prepareVerificationDialog(code, reason, options);
  if (!('file' in command)) return command;
  try {
    execFileSync(command.file, command.args, { input: command.input, stdio: VERIFY_DIALOG_STDIO, windowsHide: true });
    return { success: true, buttonClicked: command.button };
  } catch {
    return { success: false, error: 'Dialog cancelled or error occurred' };
  }
}

/** Nonblocking variant used by server-side verification notifications. */
export async function showVerificationDialogAsync(code: string, reason: string, options: DialogOptions = {}): Promise<DialogResult> {
  const command = prepareVerificationDialog(code, reason, options);
  if (!('file' in command)) return command;
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command.file, command.args, { detached: true, stdio: VERIFY_DIALOG_STDIO, windowsHide: true });
      child.once('error', reject);
      child.once('exit', resolve);
      child.stdin.on('error', reject);
      child.stdin.end(command.input);
      child.unref();
    });
    return exitCode === 0 ? { success: true, buttonClicked: command.button } : { success: false, error: 'Dialog cancelled' };
  } catch {
    return { success: false, error: 'Failed to start verification dialog' };
  }
}

/** Whether a supported native dialog tool is installed. */
export function isDialogAvailable(): boolean {
  try {
    const currentPlatform = platform();
    return currentPlatform === 'darwin' || currentPlatform === 'win32' ||
      (currentPlatform === 'linux' && findLinuxDialog() !== undefined);
  } catch {
    return false;
  }
}
