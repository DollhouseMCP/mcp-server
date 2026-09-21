import { randomBytes } from 'node:crypto';
import { TEST_CREDENTIALS } from '../../fixtures/testCredentials.js';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import { GithubSocialMethod } from '../../../src/auth/embedded-as/methods/GithubSocialMethod.js';
import { PostgresAuthStorageLayer } from '../../../src/auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import { PostgresConsoleAccountAllowlistStore } from '../../../src/web-console/stores/PostgresConsoleAccountAllowlistStore.js';
import { PostgresConsoleAccountAdminStore } from '../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { PostgresConsoleSessionStore } from '../../../src/web-console/stores/PostgresConsoleSessionStore.js';
import { PostgresLoginTransactionStore } from '../../../src/web-console/stores/PostgresLoginTransactionStore.js';
import { PostgresConsoleIdentityResolver } from '../../../src/web-console/identity/PostgresConsoleIdentityResolver.js';
import { EmbeddedAsConsoleOAuthClient } from '../../../src/web-console/auth/EmbeddedAsConsoleOAuthClient.js';
import { createConsoleBffAuthModule } from '../../../src/web-console/auth/ConsoleBffAuthModule.js';
import { AeadSecretEncryptionService } from '../../../src/web-console/security/SecretEncryption.js';
import { assembleSecuredConsoleRouter, ConsoleModuleRegistry, HmacConsoleOpaqueValueService,
  InMemoryAdminAuditWriter, InMemoryIdempotencyStore, InMemoryRuntimeSessionControlStore } from '../../../src/web-console/index.js';
import { CookieJar, absoluteUrl, approveClientConsentPage, getFreePort, startASHarness } from '../../integration/auth/oauth-flow-helpers.js';

/** All local auth routing/token verification is real; only upstream GitHub is fake. */
export async function ordinaryGithubConsole(db: DatabaseInstance, githubId: number, providerEmail: string) {
  const port = await getFreePort(), origin = `http://127.0.0.1:${port}`;
  const storage = new PostgresAuthStorageLayer({ db }), sessions = new PostgresConsoleSessionStore(db);
  const resolver = new PostgresConsoleIdentityResolver(db), opaque = new HmacConsoleOpaqueValueService(randomBytes(32));
  let verifiedPrimary = true;
  const providerCalls: string[] = [];
  const method = new GithubSocialMethod({ storage, clientId: 'ordinary-test-client', clientSecret: TEST_CREDENTIALS.MOCK_SECRET,
    callbackUrl: `${origin}/auth/social/github/callback`, allowlistRequired: true,
    signInAllowlistAuthority: new PostgresConsoleAccountAllowlistStore(db),
    fetchImpl: async input => {
      const url = String(input); providerCalls.push(url);
      let body;
      if (url === 'https://github.com/login/oauth/access_token') body = { access_token: TEST_CREDENTIALS.MOCK_GITHUB_OAUTH };
      else if (url === 'https://api.github.com/user') body = { id: githubId, login: 'ordinary-invited-user', name: 'GitHub display' };
      else if (url === 'https://api.github.com/user/emails') body = [{ email: providerEmail, primary: true, verified: verifiedPrimary }];
      else throw new Error('Unexpected upstream route');
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    } });
  const registry = new ConsoleModuleRegistry();
  registry.register(createConsoleBffAuthModule({ oauthClient: new EmbeddedAsConsoleOAuthClient({ publicBaseUrl: origin }),
    loginTransactions: new PostgresLoginTransactionStore(db), sessionStore: sessions, identityResolver: resolver,
    accountAdminStore: new PostgresConsoleAccountAdminStore(db), opaqueValues: opaque,
    secretEncryption: new AeadSecretEncryptionService({ keyId: 'ordinary-login-test', key: randomBytes(32) }), publicBaseUrl: origin }));
  const harness = await startASHarness({ methods: [method], storage, publicBaseUrl: origin, port,
    configureApp: app => app.use(assembleSecuredConsoleRouter(registry, { sessionStore: sessions, identityResolver: resolver,
      opaqueValues: opaque, consoleOrigin: origin, adminAuditWriter: new InMemoryAdminAuditWriter(),
      idempotencyStore: new InMemoryIdempotencyStore(), runtimeStore: new InMemoryRuntimeSessionControlStore(), idleTimeoutMs: 3600000 })) });
  return { close: harness.close, sessions, opaque, providerCalls,
    async login(verified: boolean) {
      verifiedPrimary = verified;
      const jar = new CookieJar(); // Intentionally no restricted onboarding or prior normal cookies.
      const visit = async (url: string) => {
        const response = await fetch(absoluteUrl(origin, url), { redirect: 'manual', headers: { Cookie: jar.header() } });
        jar.ingest(response.headers); return response;
      };
      const login = await visit('/api/v1/auth/login?return_to=/console');
      if (login.status !== 302) throw new Error(`Login start status ${login.status}`);
      const authorize = await visit(login.headers.get('location')!);
      if (![302, 303].includes(authorize.status)) throw new Error(`Authorize status ${authorize.status}`);
      const github = await visit(authorize.headers.get('location')!);
      const redirect = new URL(github.headers.get('location')!);
      if (redirect.origin !== 'https://github.com') throw new Error('Unexpected authorization redirect');
      const state = redirect.searchParams.get('state')!;
      const callback = await visit(`/auth/social/github/callback?code=ordinary-test-code&state=${encodeURIComponent(state)}`);
      if (!verified) return { callback, me: await visit('/api/v1/auth/me'), session: null, replay: null };
      if (callback.status !== 200) throw new Error(`GitHub callback status ${callback.status}`);
      let response = await approveClientConsentPage({ baseUrl: origin, response: callback, jar });
      jar.ingest(response.headers);
      let bffCallback: string | undefined, callbackCookies = '';

      for (let hop = 0; hop < 10; hop++) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`Missing login redirect (${response.status})`);
        const next = new URL(location, origin);
        if (next.pathname === '/console') break;
        if (next.pathname === '/api/v1/auth/callback') { bffCallback = next.toString(); callbackCookies = jar.header(); }
        response = await visit(next.toString());
      }
      if (!bffCallback) throw new Error('Ordinary callback was not reached');
      const session = /(?:^|; )dh_session=([^;]+)/.exec(jar.header())?.[1] ?? null;
      const me = await visit('/api/v1/auth/me');
      const replay = await fetch(bffCallback, { redirect: 'manual', headers: { Cookie: callbackCookies } });
      return { callback, me, session, replay };
    } };
}
