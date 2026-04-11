/**
 * NVM Launcher — Integration Tests
 *
 * Verifies that the generated bash wrapper script:
 *   1. Is syntactically valid bash
 *   2. Actually executes and passes arguments through to npx
 *   3. Skips NVM sourcing when NVM is absent (safe no-op)
 *   4. Creates wrapper + patches config in a real end-to-end sequence
 *   5. Hardcodes the resolved NVM_DIR so it works without shell profile
 *   6. Handles non-standard NVM_DIR locations (Homebrew NVM etc.)
 *
 * Environment probing (beforeAll):
 *   - bashAvailable  — bash is in PATH; skips all bash-execution tests if false
 *   - binBashExists  — /bin/bash exists; skips the sh-compat test if false
 *                      (sh honours #!/bin/bash shebang only when that path resolves)
 *   - tmpExec        — scripts in tmpdir() can be exec'd (no noexec mount);
 *                      skips execution tests if false
 *
 * Tests that only read or write files (CRLF check, whitespace, NVM_DIR
 * detection, config patching) run unconditionally on non-Windows.
 *
 * All tests are skipped on Windows (bash not available; NVM mitigation
 * is macOS/Linux only by design).
 *
 * See: https://github.com/DollhouseMCP/mcp-server/issues/1902
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import {
  ensureNvmLauncher,
  patchConfigForNvmLauncher,
  isNvmPresent,
} from '../../../src/web/routes/setupRoutes.js';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

// ── Environment capability flags ─────────────────────────────────────────────
// Probed once in beforeAll. Tests guard on these instead of crashing.

let bashAvailable = false;   // bash is in PATH
let binBashExists = false;   // /bin/bash exists at that exact path (shebang target)
let tmpExec = false;         // scripts in os.tmpdir() can be execed (no noexec mount)

beforeAll(async () => {
  if (isWindows) return;

  // 1. Is bash in PATH?
  try {
    await execFileAsync('bash', ['--version'], { timeout: 5_000 });
    bashAvailable = true;
  } catch {
    return; // no bash — all bash-dependent tests will be skipped gracefully
  }

  // 2. Does /bin/bash exist and is executable?
  //    The sh compat test relies on the shebang #!/bin/bash resolving to this path.
  try {
    await access('/bin/bash', fsConstants.X_OK);
    binBashExists = true;
  } catch {
    // bash is in PATH but not at /bin/bash (e.g. /usr/local/bin/bash on some Linuxes)
  }

  // 3. Can scripts be exec'd from the OS temp directory?
  //    Fails on Docker with --tmpfs /tmp:noexec. The wrapper uses `exec npx "$@"`
  //    where npx lives in a temp subdirectory; if noexec is set that exec fails.
  const probeDir = await mkdtemp(join(tmpdir(), 'dollhouse-exec-probe-'));
  try {
    const probe = join(probeDir, 'probe.sh');
    await writeFile(probe, '#!/bin/bash\ntrue\n', 'utf-8');
    await chmod(probe, 0o755);
    // Call bash explicitly so we only test the exec of the probe, not the shebang
    await execFileAsync('bash', [probe], { timeout: 5_000 });
    tmpExec = true;
  } catch {
    // noexec or other execution restriction
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
});

// ── Shared temp directory setup ───────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dollhouse-nvm-integration-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  delete process.env.NVM_DIR;
});

// ── Bash syntax validation ───────────────────────────────────────────────────
// bash -n only reads/parses the script; it does NOT exec it.
// These tests need bash available but do NOT need tmpExec.

describe('Generated script — bash syntax', () => {
  it('passes bash -n (no syntax errors)', async () => {
    if (isWindows || !bashAvailable) return;
    const wrapperPath = await ensureNvmLauncher(tempDir);
    await expect(execFileAsync('bash', ['-n', wrapperPath])).resolves.not.toThrow();
  });

  it('script has Unix line endings (no CRLF)', async () => {
    if (isWindows) return;
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).not.toContain('\r\n');
  });

  it('script has no trailing whitespace on any line', async () => {
    if (isWindows) return;
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });
});

// ── Script execution — argument pass-through ─────────────────────────────────
// These tests exec scripts from the temp directory.
// Require: bash available AND tmpExec (no noexec mount on /tmp).

describe('Generated script — execution', () => {
  it('passes arguments through to npx unchanged', async () => {
    if (isWindows || !bashAvailable || !tmpExec) return;

    const wrapperPath = await ensureNvmLauncher(tempDir);
    const fakeBinDir = join(tempDir, 'fake-bin');
    const fakeNpx = join(fakeBinDir, 'npx');
    const logFile = join(tempDir, 'npx-call.log');

    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(fakeNpx, `#!/bin/bash\nprintf '%s' "$*" > "${logFile}"\n`, 'utf-8');
    await chmod(fakeNpx, 0o755);

    const env = {
      ...process.env,
      HOME: tempDir,
      NVM_DIR: join(tempDir, '.nvm'),
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    };

    await execFileAsync('bash', [wrapperPath, '@dollhousemcp/mcp-server@latest'], { env, timeout: 10_000 });

    const logged = await readFile(logFile, 'utf-8');
    expect(logged).toBe('@dollhousemcp/mcp-server@latest');
  });

  it('passes multiple arguments through unchanged', async () => {
    if (isWindows || !bashAvailable || !tmpExec) return;

    const wrapperPath = await ensureNvmLauncher(tempDir);
    const fakeBinDir = join(tempDir, 'fake-bin2');
    const fakeNpx = join(fakeBinDir, 'npx');
    const logFile = join(tempDir, 'multi-args.log');

    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(fakeNpx, `#!/bin/bash\nprintf '%s\\n' "$@" > "${logFile}"\n`, 'utf-8');
    await chmod(fakeNpx, 0o755);

    const env = {
      ...process.env,
      HOME: tempDir,
      NVM_DIR: join(tempDir, '.nvm'),
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    };

    await execFileAsync('bash', [wrapperPath, '@dollhousemcp/mcp-server@rc', '--yes'], { env, timeout: 10_000 });

    const logged = await readFile(logFile, 'utf-8');
    const args = logged.trim().split('\n');
    expect(args).toEqual(['@dollhousemcp/mcp-server@rc', '--yes']);
  });

  it('skips NVM block when ~/.nvm/nvm.sh is absent (safe no-op)', async () => {
    if (isWindows || !bashAvailable || !tmpExec) return;

    const wrapperPath = await ensureNvmLauncher(tempDir);
    const fakeBinDir = join(tempDir, 'fake-bin3');
    const fakeNpx = join(fakeBinDir, 'npx');
    const logFile = join(tempDir, 'nvm-skip.log');

    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(fakeNpx, `#!/bin/bash\necho "ok" > "${logFile}"\n`, 'utf-8');
    await chmod(fakeNpx, 0o755);

    const env = {
      ...process.env,
      HOME: tempDir,
      NVM_DIR: join(tempDir, '.nvm'),  // no nvm.sh here
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    };

    await execFileAsync('bash', [wrapperPath, 'test-arg'], { env, timeout: 10_000 });

    const logged = await readFile(logFile, 'utf-8');
    expect(logged.trim()).toBe('ok');
  });

  it('skips NVM block when a hardcoded non-existent NVM path is used', async () => {
    if (isWindows || !bashAvailable || !tmpExec) return;

    const nonExistentNvmDir = join(tempDir, 'no-such-nvm');
    const wrapperPath = await ensureNvmLauncher(tempDir, nonExistentNvmDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain(`NVM_DIR="${nonExistentNvmDir}"`);

    const fakeBinDir = join(tempDir, 'fake-bin-nopath');
    const fakeNpx = join(fakeBinDir, 'npx');
    const logFile = join(tempDir, 'nopath.log');

    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(fakeNpx, `#!/bin/bash\necho "reached" > "${logFile}"\n`, 'utf-8');
    await chmod(fakeNpx, 0o755);

    const env = {
      ...process.env,
      HOME: tempDir,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    };

    await execFileAsync('bash', [wrapperPath, 'dummy'], { env, timeout: 10_000 });
    const logged = await readFile(logFile, 'utf-8');
    expect(logged.trim()).toBe('reached');
  });
});

// ── Non-standard NVM_DIR (Homebrew-style) ────────────────────────────────────
// Detection and script-content tests: only file I/O + env vars, no exec needed.
// The execution sub-test (wrapper skips sourcing) still needs tmpExec.

describe('Non-standard NVM_DIR', () => {
  it('isNvmPresent detects NVM when NVM_DIR env var points at a custom location', async () => {
    if (isWindows) return;

    const customNvmDir = join(tempDir, 'homebrew-nvm');
    await mkdir(customNvmDir, { recursive: true });
    await writeFile(join(customNvmDir, 'nvm.sh'), '# nvm');

    process.env.NVM_DIR = customNvmDir;
    const result = await isNvmPresent(tempDir);
    expect(result).toBe(true);
  });

  it('ensureNvmLauncher hardcodes the env NVM_DIR path when no override given', async () => {
    if (isWindows) return;

    const customNvmDir = join(tempDir, 'homebrew-nvm');
    process.env.NVM_DIR = customNvmDir;

    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain(`NVM_DIR="${customNvmDir}"`);
  });

  it('wrapper with custom NVM_DIR skips sourcing when the custom dir has no nvm.sh', async () => {
    if (isWindows || !bashAvailable || !tmpExec) return;

    const customNvmDir = join(tempDir, 'empty-nvm');
    await mkdir(customNvmDir, { recursive: true });

    const wrapperPath = await ensureNvmLauncher(tempDir, customNvmDir);

    const fakeBinDir = join(tempDir, 'fake-bin-custom');
    const fakeNpx = join(fakeBinDir, 'npx');
    const logFile = join(tempDir, 'custom-nvm-skip.log');

    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(fakeNpx, `#!/bin/bash\necho "ok" > "${logFile}"\n`, 'utf-8');
    await chmod(fakeNpx, 0o755);

    const env = {
      ...process.env,
      HOME: tempDir,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    };

    await execFileAsync('bash', [wrapperPath, 'test'], { env, timeout: 10_000 });
    expect((await readFile(logFile, 'utf-8')).trim()).toBe('ok');
  });
});

// ── End-to-end: detect → create → patch sequence ────────────────────────────

describe('End-to-end NVM mitigation sequence', () => {
  it('isNvmPresent → ensureNvmLauncher → patchConfigForNvmLauncher in sequence', async () => {
    if (isWindows) return;

    // 1. Seed NVM
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm');

    // 2. Seed a realistic Claude Desktop config
    const configPath = join(tempDir, 'claude_desktop_config.json');
    const initial = {
      globalShortcut: 'Cmd+Shift+.',
      mcpServers: {
        someothertool: { command: 'node', args: ['other.js'] },
        dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@latest'] },
      },
    };
    await writeFile(configPath, JSON.stringify(initial, null, 2));

    // 3. Run the full sequence
    expect(await isNvmPresent(tempDir)).toBe(true);
    const wrapperPath = await ensureNvmLauncher(tempDir);
    await patchConfigForNvmLauncher('claude', wrapperPath, configPath);

    // 4. Verify wrapper exists and is executable
    const { stat } = await import('node:fs/promises');
    const wrapperStat = await stat(wrapperPath);
    expect(wrapperStat.isFile()).toBe(true);
    expect(wrapperStat.mode & 0o111).toBeTruthy();

    // 5. Verify config was patched correctly
    const patched = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(patched.mcpServers.dollhousemcp.command).toBe(wrapperPath);
    expect(patched.mcpServers.dollhousemcp.args).toEqual(['@dollhousemcp/mcp-server@latest']);

    // 6. Verify collateral damage: other keys preserved
    expect(patched.globalShortcut).toBe('Cmd+Shift+.');
    expect(patched.mcpServers.someothertool).toEqual({ command: 'node', args: ['other.js'] });

    // 7. Bash syntax check — requires bash but NOT tmpExec (bash -n only parses)
    if (bashAvailable) {
      await expect(execFileAsync('bash', ['-n', wrapperPath])).resolves.not.toThrow();
    }
  });

  it('full sequence is idempotent', async () => {
    if (isWindows) return;

    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm');

    const configPath = join(tempDir, 'claude.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: { dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@latest'] } },
    }, null, 2));

    for (let i = 0; i < 2; i++) {
      const wrapperPath = await ensureNvmLauncher(tempDir);
      await patchConfigForNvmLauncher('claude', wrapperPath, configPath);
    }

    const final = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(final.mcpServers.dollhousemcp.command).toContain('dollhousemcp-nvm.sh');
    expect(final.mcpServers.dollhousemcp.args).toEqual(['@dollhousemcp/mcp-server@latest']);
  });

  it('no-ops cleanly when NVM is absent', async () => {
    if (isWindows) return;

    expect(await isNvmPresent(tempDir)).toBe(false);
    await expect(ensureNvmLauncher(tempDir)).resolves.toBeDefined();
  });
});

// ── Shell compatibility ───────────────────────────────────────────────────────

describe('Generated script — shell compatibility', () => {
  it('executes cleanly under bash', async () => {
    if (isWindows || !bashAvailable || !tmpExec) return;

    const wrapperPath = await ensureNvmLauncher(tempDir);
    const fakeBinDir = join(tempDir, 'fake-bin-compat');
    const fakeNpx = join(fakeBinDir, 'npx');
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(fakeNpx, '#!/bin/bash\ntrue\n', 'utf-8');
    await chmod(fakeNpx, 0o755);

    const env = {
      ...process.env,
      HOME: tempDir,
      NVM_DIR: join(tempDir, '.nvm'),
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    };
    await expect(
      execFileAsync('bash', [wrapperPath, 'dummy'], { env, timeout: 10_000 })
    ).resolves.not.toThrow();
  });

  it('executes cleanly under sh (POSIX compatibility)', async () => {
    if (isWindows || !bashAvailable || !binBashExists || !tmpExec) return;
    // binBashExists guard: sh honours #!/bin/bash by exec-ing /bin/bash directly.
    // If bash lives elsewhere (e.g. /usr/local/bin/bash), that exec fails.

    let shPath: string;
    try {
      const { stdout } = await execFileAsync('which', ['sh'], { timeout: 5_000 });
      shPath = stdout.trim();
      if (!shPath) return;
    } catch {
      return; // sh not available or 'which' not present
    }

    const wrapperPath = await ensureNvmLauncher(tempDir);
    const fakeBinDir = join(tempDir, 'fake-bin-sh');
    const fakeNpx = join(fakeBinDir, 'npx');
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(fakeNpx, '#!/bin/sh\ntrue\n', 'utf-8');
    await chmod(fakeNpx, 0o755);

    const env = {
      ...process.env,
      HOME: tempDir,
      NVM_DIR: join(tempDir, '.nvm'),
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    };
    await expect(
      execFileAsync(shPath, [wrapperPath, 'dummy'], { env, timeout: 10_000 })
    ).resolves.not.toThrow();
  });
});
