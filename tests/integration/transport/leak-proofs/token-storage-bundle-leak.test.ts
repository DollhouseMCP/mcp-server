/**
 * Leak proof #1: token-storage-bundle-leak
 *
 * Audit claim: GitHubAuthHandler is constructed against the root-container
 * TokenManager (no authDir → defaults to `~/.dollhouse/.auth/`).
 * The per-user TokenManager registered in each HTTP session's child container
 * never reaches the shared GitHubAuthHandler, so every session's token writes
 * land at the shared operator path regardless of userId.
 *
 * This test makes the claim falsifiable by inspecting which `tokenDir` is
 * actually held by the TokenManager that GitHubAuthHandler and
 * GitHubAuthManager use at runtime.
 *
 * We cannot call `setup_github_auth` end-to-end in a unit test (it spawns an
 * OAuth helper process and contacts GitHub). Instead we resolve the service
 * chain from the container and inspect the `tokenDir` property of the live
 * TokenManager instance held by GitHubAuthManager.
 *
 * EXPECTED (audit is correct): tokenDir === DEFAULT_TOKEN_DIR
 *   (~/.dollhouse/.auth) — shared across all HTTP sessions.
 * EXPECTED (audit is wrong): tokenDir is per-user
 *   (<root>/users/<userId>/auth/).
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createHttpTestEnvironment,
  type HttpTestEnvironment,
} from '../../../helpers/httpTransportHelper.js';
import { GitHubAuthManager } from '../../../../src/auth/GitHubAuthManager.js';
import { TokenManager } from '../../../../src/security/tokenManager.js';

const ENV_STARTUP_TIMEOUT = 20_000;

const USER_A = 'alice';
const USER_B = 'bob';

describe('token-storage-bundle-leak: GitHubAuthHandler uses root TokenManager', () => {
  let env: HttpTestEnvironment;
  let homeOverride: string;

  beforeAll(async () => {
    homeOverride = await fs.mkdtemp(path.join(os.tmpdir(), 'token-leak-home-'));
    env = await createHttpTestEnvironment({
      homeDirOverride: homeOverride,
      userIdSequence: [USER_A, USER_B],
    });
  }, ENV_STARTUP_TIMEOUT);

  afterAll(async () => {
    await env?.cleanup();
    await fs.rm(homeOverride, { recursive: true, force: true }).catch(() => {});
  });

  it('GitHubAuthManager holds the ROOT-scoped TokenManager, not a per-user instance', () => {
    // Resolve both to inspect which instance GitHubAuthManager actually holds.
    const rootTokenManager = env.container.resolve<TokenManager>('TokenManager');
    const authManager = env.container.resolve<GitHubAuthManager>('GitHubAuthManager');

    // GitHubAuthManager stores its TokenManager as a private field.
    // Access via cast to expose it for the assertion.
    const authManagerInternal = authManager as unknown as { tokenManager: TokenManager };
    const authManagerTokenManager = authManagerInternal.tokenManager;

    // The root TokenManager has DEFAULT_TOKEN_DIR = path.join(homedir(), '.dollhouse', '.auth')
    // which is NOT per-user. If these are the same instance the root one is shared.
    const rootTokenDir = (rootTokenManager as unknown as { tokenDir: string }).tokenDir;
    const authTokenDir = (authManagerTokenManager as unknown as { tokenDir: string }).tokenDir;

    // FAIL (leak proven): both dirs are the same operator-level path.
    // PASS (audit wrong): authTokenDir is a per-user path.
    const defaultOpPath = path.join(os.homedir(), '.dollhouse', '.auth');

    // Document both paths so the test output is readable
    console.log('[token-storage-bundle-leak] rootTokenDir:', rootTokenDir);
    console.log('[token-storage-bundle-leak] authTokenDir:', authTokenDir);
    console.log('[token-storage-bundle-leak] os.homedir() default:', defaultOpPath);

    // This assertion FAILS (proving the leak) when both equal the operator path.
    // It PASSES (disproving the leak) only if authTokenDir is user-scoped.
    expect(authTokenDir).not.toEqual(defaultOpPath);
  });

  it('per-user child-container TokenManager uses user-scoped authDir', () => {
    // The child container created per HTTP session DOES register a per-user
    // TokenManager — but is that the one the handlers actually use?
    // This test documents the userAuthDir that *would* be used if wiring were correct.
    const userPathResolver = env.container.resolve<import('../../../../src/paths/IUserPathResolver.js').IUserPathResolver>('UserPathResolver');
    const aliceAuthDir = userPathResolver.getUserAuthDir(USER_A);
    const bobAuthDir = userPathResolver.getUserAuthDir(USER_B);

    console.log('[token-storage-bundle-leak] alice authDir:', aliceAuthDir);
    console.log('[token-storage-bundle-leak] bob authDir:', bobAuthDir);

    // The per-user auth dirs should be different from each other.
    expect(aliceAuthDir).not.toEqual(bobAuthDir);

    // And should be distinct from the operator default.
    const defaultOpPath = path.join(os.homedir(), '.dollhouse', '.auth');
    expect(aliceAuthDir).not.toEqual(defaultOpPath);
    expect(bobAuthDir).not.toEqual(defaultOpPath);
  });
});
