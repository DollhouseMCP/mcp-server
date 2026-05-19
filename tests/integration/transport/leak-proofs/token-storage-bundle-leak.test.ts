/**
 * Leak proof #1: token-storage-bundle-leak
 *
 * Step 3 regression: HTTP session handlers must resolve GitHubAuthManager
 * through their SessionContainer so token writes use per-user auth dirs.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createHttpTestEnvironment,
  connectHttpClient,
  type HttpTestEnvironment,
  type HttpClientHandle,
} from '../../../helpers/httpTransportHelper.js';
import { GitHubAuthManager } from '../../../../src/auth/GitHubAuthManager.js';
import { TokenManager } from '../../../../src/security/tokenManager.js';
import type { SessionContainerRegistry } from '../../../../src/di/SessionContainerRegistry.js';
import type { GitHubAuthHandler } from '../../../../src/handlers/GitHubAuthHandler.js';

const ENV_STARTUP_TIMEOUT = 20_000;

const USER_A = 'alice';
const USER_B = 'bob';

describe('token-storage-bundle-leak: HTTP GitHub auth handlers use session TokenManager', () => {
  let env: HttpTestEnvironment;
  let homeOverride: string;
  let handleA: HttpClientHandle;
  let handleB: HttpClientHandle;

  beforeAll(async () => {
    homeOverride = await fs.mkdtemp(path.join(os.tmpdir(), 'token-leak-home-'));
    env = await createHttpTestEnvironment({
      homeDirOverride: homeOverride,
      userIdSequence: [USER_A, USER_B],
    });
    handleA = await connectHttpClient(env.runtime);
    handleB = await connectHttpClient(env.runtime);
  }, ENV_STARTUP_TIMEOUT);

  afterAll(async () => {
    await handleA?.disconnect();
    await handleB?.disconnect();
    await env?.cleanup();
    await fs.rm(homeOverride, { recursive: true, force: true }).catch(() => {});
  });

  it('root GitHubAuthManager still uses the operator TokenManager fallback', () => {
    const rootTokenManager = env.container.resolve<TokenManager>('TokenManager');
    const authManager = env.container.resolve<GitHubAuthManager>('GitHubAuthManager');
    const authManagerInternal = authManager as unknown as { tokenManager: TokenManager };
    const authManagerTokenManager = authManagerInternal.tokenManager;

    expect(authManagerTokenManager).toBe(rootTokenManager);
  });

  it('per-session GitHubAuthManager and handler use user-scoped TokenManagers', async () => {
    const userPathResolver = env.container.resolve<import('../../../../src/paths/IUserPathResolver.js').IUserPathResolver>('UserPathResolver');
    const aliceAuthDir = userPathResolver.getUserAuthDir(USER_A);
    const bobAuthDir = userPathResolver.getUserAuthDir(USER_B);
    const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const childA = registry.get(env.sessionContexts[0].sessionId);
    const childB = registry.get(env.sessionContexts[1].sessionId);
    expect(childA).toBeDefined();
    expect(childB).toBeDefined();

    const authManagerA = childA!.resolve<GitHubAuthManager>('GitHubAuthManager');
    const authManagerB = childB!.resolve<GitHubAuthManager>('GitHubAuthManager');
    const tokenManagerA = (authManagerA as unknown as { tokenManager: TokenManager }).tokenManager;
    const tokenManagerB = (authManagerB as unknown as { tokenManager: TokenManager }).tokenManager;
    const authHandlerA = childA!.resolve<GitHubAuthHandler>('GitHubAuthHandler') as unknown as { githubAuthManager: GitHubAuthManager };
    const authHandlerB = childB!.resolve<GitHubAuthHandler>('GitHubAuthHandler') as unknown as { githubAuthManager: GitHubAuthManager };

    console.log('[token-storage-bundle-leak] alice authDir:', aliceAuthDir);
    console.log('[token-storage-bundle-leak] bob authDir:', bobAuthDir);

    expect(aliceAuthDir).not.toEqual(bobAuthDir);
    expect(tokenManagerA).not.toBe(tokenManagerB);

    const defaultOpPath = path.join(os.homedir(), '.dollhouse', '.auth');
    expect(aliceAuthDir).not.toEqual(defaultOpPath);
    expect(bobAuthDir).not.toEqual(defaultOpPath);
    expect(authHandlerA.githubAuthManager).toBe(authManagerA);
    expect(authHandlerB.githubAuthManager).toBe(authManagerB);

    await tokenManagerA.storeGitHubToken('ghp_ALICETOKEN000000000000000000000000000001');
    await tokenManagerB.storeGitHubToken('ghp_BOBTOKEN00000000000000000000000000000002');

    await expect(fs.access(path.join(aliceAuthDir, 'github_token.enc'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(bobAuthDir, 'github_token.enc'))).resolves.toBeUndefined();
  });
});
