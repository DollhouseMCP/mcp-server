import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { createRequire } from 'node:module';

const actualChildProcess = createRequire(import.meta.url)('node:child_process');
type Completion = (error: Error | null, stdout: string) => void;
const exec = jest.fn<(command: string, options: { encoding: string; timeout: number }, callback: Completion) => void>();
jest.unstable_mockModule('child_process', () => ({ ...actualChildProcess, exec }));
const { BuildInfoService } = await import('../../../src/services/BuildInfoService.js');
function assertBothAdmitted(gitStarted: boolean, dockerStarted: boolean): void {
  expect(gitStarted).toBe(true);
  expect(dockerStarted).toBe(true);
}

describe('BuildInfoService cold Git admission', () => {
  beforeEach(() => exec.mockReset());

  it('starts Docker before the real Git method finishes, then caches the completed Git value', async () => {
    const callbacks: Completion[] = [];
    exec.mockImplementation((_command, _options, callback) => { callbacks.push(callback); });
    const service = new BuildInfoService({} as never);
    const docker = jest.spyOn(service as never, 'getDockerInfo').mockResolvedValue({ isDocker: false } as never);
    const first = service.getBuildInfo();
    expect(exec).toHaveBeenCalledWith('git rev-parse --short HEAD', { encoding: 'utf-8', timeout: 5000 }, expect.any(Function));
    assertBothAdmitted(exec.mock.calls.length === 1, docker.mock.calls.length === 1);
    expect(callbacks).toHaveLength(1);
    callbacks[0](null, 'abc123\n');
    await Promise.resolve();
    expect(exec).toHaveBeenNthCalledWith(2, 'git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', timeout: 5000 }, expect.any(Function));
    callbacks[1](null, 'main\n');
    const info = await first;
    expect(info.build.gitCommit).toBe('abc123');
    expect(info.build.gitBranch).toBe('main');
    await service.getBuildInfo();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('coalesces simultaneous cold callers and caches Git failures', async () => {
    const callbacks: Completion[] = [];
    exec.mockImplementation((_command, _options, callback) => { callbacks.push(callback); });
    const service = new BuildInfoService({} as never);
    const git = () => (service as unknown as { getGitInfo(): Promise<{commit?: string; branch?: string}> }).getGitInfo();
    const first = git();
    const second = git();
    expect(exec).toHaveBeenCalledTimes(1);
    const timeout = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
    callbacks[0](timeout, '');
    await expect(first).resolves.toEqual({});
    await expect(second).resolves.toEqual({});
    await expect(git()).resolves.toEqual({});
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('returns and caches an empty result when the second command fails', async () => {
    const callbacks: Completion[] = [];
    exec.mockImplementation((_command, _options, callback) => { callbacks.push(callback); });
    const service = new BuildInfoService({} as never);
    const git = () => (service as unknown as { getGitInfo(): Promise<{commit?: string; branch?: string}> }).getGitInfo();
    const result = git();
    callbacks[0](null, 'abc123\n');
    await Promise.resolve();
    callbacks[1](new Error('branch command failed'), '');
    await expect(result).resolves.toEqual({});
    await expect(git()).resolves.toEqual({});
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('returns and caches an empty result if starting a command throws synchronously', async () => {
    exec.mockImplementation(() => { throw new Error('spawn failed'); });
    const service = new BuildInfoService({} as never);
    const git = () => (service as unknown as { getGitInfo(): Promise<{commit?: string; branch?: string}> }).getGitInfo();
    await expect(git()).resolves.toEqual({});
    await expect(git()).resolves.toEqual({});
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('the same admission check rejects a deliberately sequential service-shaped path', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let gitStarted = false;
    let dockerStarted = false;
    const sequentialService = async () => {
      gitStarted = true;
      await held;
      dockerStarted = true;
    };
    const pending = sequentialService();
    try {
      expect(() => assertBothAdmitted(gitStarted, dockerStarted)).toThrow();
    } finally {
      release();
      await pending;
    }
    assertBothAdmitted(gitStarted, dockerStarted);
  });
});
