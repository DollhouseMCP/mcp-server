import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

// Replace only the OS dialog in this test process. The MCP handler, startup,
// approval store and file operations run through their production entry points.
const execFile = childProcess.execFile;
const native = execFile[promisify.custom];
const fixtureExecFile = (...args) => execFile(...args);
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
  return native(file, args, options);
};

childProcess.execFile = fixtureExecFile;
syncBuiltinESMExports();
