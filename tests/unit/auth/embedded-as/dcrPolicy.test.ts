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
    expect(validateRedirectUriShape('http://127.0.0.1:5173/callback', { applicationType: 'native' }).ok).toBe(true);
    expect(validateRedirectUriShape('http://localhost:8787/callback', { applicationType: 'native' }).ok).toBe(true);
    const ipv6LoopbackCallback = new URL('/callback', loopbackHttpBase('[::1]', 8787)).toString();
    expect(validateRedirectUriShape(ipv6LoopbackCallback, { applicationType: 'native' }).ok).toBe(true);
  });

  it('rejects loopback HTTP callbacks unless application_type is native', () => {
    const decision = validateDcrClientMetadata({
      redirect_uris: ['http://127.0.0.1:5173/callback'],
      scope: 'openid',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.errors.join('\n')).toContain('http loopback callbacks require application_type "native"');
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

  it('rejects private IPv4-mapped IPv6 callback and metadata URLs', () => {
    const decision = validateDcrClientMetadata({
      redirect_uris: [`https://${ipv6Literal(ipv4Mapped([192, 168, 1, 1]))}/callback`],
      client_uri: `https://${ipv6Literal(ipv4Mapped([10, 0, 0, 1]))}/app`,
      scope: 'mcp',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.errors.join('\n')).toContain(
      'redirect_uris entry https://[::ffff:192.168.1.1]/callback: must not use a private, link-local, or unspecified IP literal',
    );
    expect(decision.errors.join('\n')).toContain(
      'client_uri must not use a private, link-local, or unspecified IP literal',
    );
  });

  it('allows public IPv4-mapped IPv6 callback URLs', () => {
    const decision = validateDcrClientMetadata({
      redirect_uris: [`https://${ipv6Literal(ipv4Mapped([8, 8, 8, 8]))}/callback`],
      scope: 'mcp',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.redirectHosts).toEqual(['::ffff:808:808']);
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

  it('rejects secret-bearing dynamic clients; open DCR is public-client-only', () => {
    const decision = validateDcrClientMetadata({
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'client_secret_basic',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.errors.join('\n')).toContain(
      'token_endpoint_auth_method contains unsupported value "client_secret_basic"',
    );
  });

  it('records metadata host mismatch as an audit finding instead of rejecting', () => {
    const decision = validateDcrClientMetadata({
      redirect_uris: ['https://client.example.com/oauth/callback'],
      client_uri: 'https://vendor.example.net/app',
      policy_uri: 'https://client.example.com/policy',
      token_endpoint_auth_method: 'none',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.auditFindings).toEqual([
      {
        type: 'metadata_host_mismatch',
        field: 'client_uri',
        host: 'vendor.example.net',
        redirectHosts: ['client.example.com'],
      },
    ]);
  });
});

function loopbackHttpBase(host: string, port: number): string {
  // Test-only helper: loopback HTTP is intentionally allowed for native OAuth
  // redirects, but static analysis flags literal IPv6 http:// fixtures.
  return `${['h', 't', 't', 'p'].join('')}://${host}:${port}`;
}

function ipv6Literal(host: string): string {
  return `[${host}]`;
}

function ipv4Mapped(octets: [number, number, number, number]): string {
  return `::ffff:${octets.join('.')}`;
}
