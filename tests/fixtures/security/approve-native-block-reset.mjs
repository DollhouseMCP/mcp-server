import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

// Replace only the OS dialog in this test process. The MCP handler, startup,
// approval store and file operations run through their production entry points.
const execFile = childProcess.execFile;
const native = execFile[promisify.custom];
const fixtureExecFile = (...args) => execFile(...args);
fixtureExecFile[promisify.custom] = (file, args, options) => {
  if (file === '/usr/bin/osascript' && args[1]?.includes('default button "Cancel"')) {
    return Promise.resolve({ stdout: 'reset\n', stderr: '' });
  }
  if (file === 'zenity' && args.includes('--default-cancel')) {
    return Promise.resolve({ stdout: '', stderr: '' });
  }
  if (file === 'powershell.exe' && args.includes('-STA') && options.env?.DOLLHOUSE_NATIVE_RESET_PROOF === '0') {
    return Promise.resolve({ stdout: 'reset', stderr: '' });
  }
  return native(file, args, options);
};

childProcess.execFile = fixtureExecFile;
syncBuiltinESMExports();
