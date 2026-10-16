/** Test-only dependency contract; never selects an application interpreter. */
import { win32 } from 'node:path';

export const MODEL_PYTHON_CONTRACT = 'github-cache-cpython-3.12.10-x64';

export function modelPythonCommand(platform: NodeJS.Platform, architecture: string, env: NodeJS.ProcessEnv): string {
  if (platform !== 'win32') return 'python3';
  const ci = env.GITHUB_ACTIONS === 'true' || Boolean(env.CI && env.CI !== 'false');
  if (!ci) return 'python';
  if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true' || architecture !== 'x64' ||
      env.DOLLHOUSE_MODEL_PYTHON_CONTRACT !== MODEL_PYTHON_CONTRACT) {
    throw new Error('Windows CI model requires its declared GitHub cache-only Python contract');
  }
  // RUNNER_TOOL_CACHE is supplied by the trusted workflow's GitHub runner.
  // This validates spelling/containment, not files, junctions or binary identity.
  const root = env.RUNNER_TOOL_CACHE;
  if (!root || !/^[A-Za-z]:\\/.test(root) || root.includes('/') || win32.normalize(root) !== root) {
    throw new Error('Windows CI model requires a canonical runner tool-cache root');
  }
  const components = root.slice(3).split('\\');
  if (components.some(part => !/^[A-Za-z0-9._ -]+$/.test(part) || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Windows CI model requires a canonical runner tool-cache root');
  }
  // Cache absence is intentionally left to the original single spawnSync error
  // assertion. No search, preflight, download, retry or ambient fallback.
  return win32.join(root, 'Python', '3.12.10', 'x64', 'python.exe');
}
