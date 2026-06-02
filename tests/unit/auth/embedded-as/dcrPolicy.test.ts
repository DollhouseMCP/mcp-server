import { describe, expect, it } from '@jest/globals';
import {
  validateDcrClientMetadata,
  validateRedirectUriShape,
} from '../../../../src/auth/embedded-as/dcrPolicy.js';

describe('dcrPolicy — issue #2220 constrained open DCR', () => {
  it('allows HTTPS callback URLs for unknown clients', () => {
    const decision = validateDcrClientMetadata({
      client_name: 'Example MCP Client',
      redirect_uris: ['https://client.example.com/oauth/callback'],
      scope: 'openid offline_access mcp profile email',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.redirectHosts).toEqual(['client.example.com']);
  });

  it('allows loopback HTTP callbacks for local/native MCP clients', () => {
    expect(validateRedirectUriShape('http://127.0.0.1:5173/callback').ok).toBe(true);
    expect(validateRedirectUriShape('http://localhost:8787/callback').ok).toBe(true);
    expect(validateRedirectUriShape('http://[::1]:8787/callback').ok).toBe(true);
  });

  it('rejects non-loopback HTTP callbacks, fragments, and userinfo', () => {
    const decision = validateDcrClientMetadata({
      redirect_uris: [
        'http://client.example.com/callback',
        'https://user:pass@client.example.com/callback',
        'https://client.example.com/callback#token',
      ],
      scope: 'mcp',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.errors.join('\n')).toContain('http callbacks are allowed only for loopback clients');
    expect(decision.errors.join('\n')).toContain('must not include username or password components');
    expect(decision.errors.join('\n')).toContain('must not include a URL fragment');
  });

  it('rejects wildcard hosts and unsupported OAuth grant shapes', () => {
    const decision = validateDcrClientMetadata({
      redirect_uris: ['https://*.example.com/callback'],
      grant_types: ['authorization_code', 'client_credentials'],
      response_types: ['code', 'token'],
      scope: 'mcp admin',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.errors.join('\n')).toContain('must not contain wildcards');
    expect(decision.errors.join('\n')).toContain('grant_types contains unsupported value "client_credentials"');
    expect(decision.errors.join('\n')).toContain('response_types contains unsupported value "token"');
    expect(decision.errors.join('\n')).toContain('scope contains unsupported value "admin"');
  });

  it('rejects metadata that would make the AS fetch arbitrary client URLs', () => {
    const decision = validateDcrClientMetadata({
      redirect_uris: ['https://client.example.com/callback'],
      jwks_uri: 'https://client.example.com/jwks.json',
      sector_identifier_uri: 'https://client.example.com/sector.json',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.errors.join('\n')).toContain('jwks_uri is not accepted');
    expect(decision.errors.join('\n')).toContain('sector_identifier_uri is not accepted');
  });
});
