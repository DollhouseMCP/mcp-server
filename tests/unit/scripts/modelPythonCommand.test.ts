import { describe, expect, it } from '@jest/globals';
import { MODEL_PYTHON_CONTRACT, modelPythonCommand } from '../../helpers/modelPythonCommand.js';

const configured = (): NodeJS.ProcessEnv => ({ CI: 'true', GITHUB_ACTIONS: 'true',
  DOLLHOUSE_MODEL_PYTHON_CONTRACT: MODEL_PYTHON_CONTRACT, RUNNER_TOOL_CACHE: 'C:\\hostedtoolcache\\windows' });

describe('Windows CI model Python dependency', () => {
  it('binds only the approved cache suffix without an arbitrary executable override', () => {
    const env = { ...configured(), DOLLHOUSE_MODEL_PYTHON_EXECUTABLE: 'untrusted-command' };
    expect(modelPythonCommand('win32', 'x64', env)).toBe('C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64\\python.exe');
    expect(modelPythonCommand('win32', 'x64', { ...env, RUNNER_TOOL_CACHE: 'D:\\runner tools' }))
      .toBe('D:\\runner tools\\Python\\3.12.10\\x64\\python.exe');
  });
  it.each(['linux', 'darwin'] as const)('preserves the %s command even with invalid Windows configuration', platform => {
    expect(modelPythonCommand(platform, 'arm64', { ...configured(), RUNNER_TOOL_CACHE: '..' })).toBe('python3');
  });
  it.each([{}, { CI: 'false' }])('preserves unconfigured Windows local behavior (%p)', env => {
    expect(modelPythonCommand('win32', 'arm64', env)).toBe('python');
  });
  it.each(['CI', 'GITHUB_ACTIONS', 'DOLLHOUSE_MODEL_PYTHON_CONTRACT', 'RUNNER_TOOL_CACHE'])('refuses missing %s in Windows CI', key => {
    const env = configured(); delete env[key];
    expect(() => modelPythonCommand('win32', 'x64', env)).toThrow('Windows CI model requires');
  });
  it.each([
    { CI: '1' }, { CI: 'false' }, { GITHUB_ACTIONS: 'false' },
    { DOLLHOUSE_MODEL_PYTHON_CONTRACT: 'different-version' },
  ])('refuses invalid CI contract %p', changed => {
    expect(() => modelPythonCommand('win32', 'x64', { ...configured(), ...changed })).toThrow('Windows CI model requires');
  });
  it('refuses another CI architecture', () => {
    expect(() => modelPythonCommand('win32', 'arm64', configured())).toThrow('Windows CI model requires');
  });
  it.each(['', '.', 'C:relative', '\\relative', '\\\\server\\share', '\\\\?\\C:\\cache',
    'C:/cache', 'C:\\cache\\..\\other', 'C:\\cache\\.\\other', 'C:\\cache\\', 'C:\\',
    'C:\\cache\\\\other', 'C:\\cache:stream', 'C:\\cache\\NUL', 'C:\\cache\\com1.txt',
    'C:\\cache\\trailing.', 'C:\\cache\\trailing ', 'C:\\cache\nother', 'C:\\cache\\%USERPROFILE%',
    'C:\\cache\\short~1', 'C:\\cache\\quote"', 'C:\\cache\\*'])('refuses an invalid synthetic root at table row %#', root => {
    const env = { ...configured(), RUNNER_TOOL_CACHE: root };
    let failure!: Error;
    try { modelPythonCommand('win32', 'x64', env); } catch (error) { failure = error as Error; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Windows CI model requires a canonical runner tool-cache root');
  });
});
