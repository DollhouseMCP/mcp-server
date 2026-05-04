/**
 * OidcBridgeMethod
 *
 * Wraps the existing OidcAuthProvider behind the IAuthMethod interface so
 * the OIDC bridge mode flows through the same EmbeddedAuthorizationServer
 * shell as the embedded-AS methods. Selected when DOLLHOUSE_OIDC_ISSUER
 * is set; the embedded AS still issues its own tokens but defers identity
 * to the upstream IdP.
 *
 * Note: this method is for ENTERPRISE mode where the operator wants users
 * to authenticate against an existing IdP (Okta / Entra / Keycloak / etc.)
 * but still receive a DollhouseMCP-issued bearer token. The "pure pass-
 * through" mode (where the upstream IdP's tokens are accepted directly,
 * with no embedded AS) is the legacy `provider: 'oidc'` path in
 * AuthProviderFactory; this method is the embedded-AS-bridges-to-IdP path.
 *
 * The bridge implementation here issues a redirect to the upstream IdP's
 * authorize endpoint (discovered from the issuer URL); the user
 * authenticates there; the IdP redirects back to our callback with the
 * code; we exchange it for the upstream token; we extract the sub and
 * upsert a local account record.
 *
 * Stage C scope keeps this as a *placeholder* with a clear "not yet wired"
 * error — the full discovery + token-exchange + JWKS fetch implementation
 * is non-trivial and the dominant deployment shape for now is GitHub
 * social. Operators with an existing IdP can use the legacy `provider:
 * 'oidc'` path until this is filled out.
 *
 * @module auth/embedded-as/methods/OidcBridgeMethod
 */

import type {
  AuthenticatedIdentity,
  IAuthMethod,
  InteractionContext,
  InteractionInput,
  InteractionResult,
  InteractionStep,
} from '../IAuthMethod.js';

export interface OidcBridgeMethodOptions {
  /** Upstream OIDC issuer URL (DOLLHOUSE_OIDC_ISSUER). */
  issuer: string;
  /** Audience claim expected in upstream tokens. */
  audience: string;
}

export class OidcBridgeMethod implements IAuthMethod {
  readonly id = 'oidc-bridge' as const;
  readonly displayName = 'Corporate SSO';

  private readonly options: OidcBridgeMethodOptions;

  constructor(options: OidcBridgeMethodOptions) {
    this.options = options;
  }

  async beginInteraction(_ctx: InteractionContext): Promise<InteractionStep> {
    // Stage C scaffolding: full implementation requires upstream OIDC
    // discovery + authorization-code flow + ID-token validation against
    // the upstream JWKS. Until then, render a clear message so operators
    // understand they should use the legacy `provider: 'oidc'` path.
    return {
      kind: 'render-html',
      html: oidcBridgePlaceholderPage(this.options.issuer),
      csrfToken: '',
    };
  }

  async completeInteraction(
    _ctx: InteractionContext,
    _input: InteractionInput,
  ): Promise<InteractionResult> {
    return {
      kind: 'denied',
      reason:
        'OIDC bridge embedded-AS mode is not yet wired. Use DOLLHOUSE_AUTH_PROVIDER=oidc ' +
        'for direct upstream-token validation while this method fills out.',
    };
  }

  async findAccount(_sub: string): Promise<AuthenticatedIdentity | null> {
    return null;
  }
}

function oidcBridgePlaceholderPage(issuer: string): string {
  const safeIssuer = issuer
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>OIDC Bridge — pending</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #f7f7f4; color: #181816; }
    main { max-width: 520px; margin: 12vh auto; padding: 32px; background: white; border: 1px solid #d8d6cc; border-radius: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>OIDC Bridge — not yet wired</h1>
    <p>This embedded-AS bridge to <code>${safeIssuer}</code> is scaffolded but the
       full OIDC authorization-code implementation lives in a later phase.</p>
    <p>For now, set <code>DOLLHOUSE_AUTH_PROVIDER=oidc</code> to use the
       legacy direct-validation path against the same issuer.</p>
  </main>
</body>
</html>`;
}
