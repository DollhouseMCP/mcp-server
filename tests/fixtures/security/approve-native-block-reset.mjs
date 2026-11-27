import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

// Replace only the OS dialog in this test process. The MCP handler, startup,
// approval store and file operations run through their production entry points.
const execFile = childProcess.execFile;
const native = execFile[promisify.custom];
const dialogCommands = new Set(['osascript', 'zenity', 'kdialog', 'xmessage', 'powershell.exe']);
const isDialog = file => dialogCommands.has(path.basename(file));
function guardedCommand(command) {
  return (file, ...args) => {
    if (isDialog(file)) throw new Error('Unstubbed native dialog in test fixture');
    return command(file, ...args);
  };
}
const fixtureExecFile = guardedCommand(execFile);
const runUnstubbedCommand = guardedCommand(native);
const expectedActions = new Map([
  ['Reset blocked-agent state', 'Reset'],
  ['Release blocked agent', 'Release'],
  ['Release permission deadlock', 'Release'],
  ['Verify agent action', 'Approve'],
  ['Confirm CLI permission', 'Approve'],
]);
fixtureExecFile[promisify.custom] = (file, args, options) => {
  if (file === '/usr/bin/osascript' && args[1]?.includes('default button "Cancel"')) {
    return Promise.resolve({ stdout: 'reset\n', stderr: '' });
  }
  if (file === 'zenity' && args.includes('--default-cancel')) {
    return Promise.resolve({ stdout: '', stderr: '' });
  }
  if (file === 'powershell.exe' && args.includes('-STA')) {
    let receive;
    const result = new Promise(resolve => { receive = resolve; });
    result.child = { stdin: { once() {}, end(input) {
      const { title, approveLabel, requireCode } = JSON.parse(input);
      const approved = expectedActions.get(title) === approveLabel && requireCode === false;
      receive({ stdout: approved ? 'reset' : 'cancel', stderr: '' });
    } } };
    return result;
  }
  return runUnstubbedCommand(file, args, options);
};

childProcess.execFile = fixtureExecFile;
childProcess.execFileSync = guardedCommand(childProcess.execFileSync);
const execSync = childProcess.execSync;
childProcess.execSync = (command, ...args) => command === 'which zenity' ? Buffer.alloc(0) : execSync(command, ...args);
childProcess.spawn = guardedCommand(childProcess.spawn);
syncBuiltinESMExports();
// Approval fixtures can opt in after the native binaries have been stubbed.
if (process.env.DOLLHOUSE_TEST_STUB_APPROVALS === 'true') {
  process.env.DOLLHOUSE_SUPPRESS_VERIFICATION_DIALOG = 'false';
}
