import { beforeAll, describe, expect, it } from '@jest/globals';

let hostedConnectionProfile: typeof import('../../../../src/web-console/ui/connect-config.js').hostedConnectionProfile;
let nativeLinkArtifacts: typeof import('../../../../src/web-console/ui/connect-native-config.js').nativeLinkArtifacts;
let nativeConnectionClients: typeof import('../../../../src/web-console/ui/connect-native-clients.js').nativeConnectionClients;

beforeAll(async () => {
  const configPath = '../../../../src/web-console/ui/connect-config';
  const linksPath = '../../../../src/web-console/ui/connect-native-config';
  const clientsPath = '../../../../src/web-console/ui/connect-native-clients';
  ({ hostedConnectionProfile } = await import(configPath));
  ({ nativeLinkArtifacts } = await import(linksPath));
  ({ nativeConnectionClients } = await import(clientsPath));
});

const origin = 'https://mcp.example.test';
const endpoint = `${origin}/remote/v2/mcp`;
const name = 'Research_2';

describe('native hosted MCP links', () => {
  it('round-trips each official payload shape without headers or commands', () => {
    const links = nativeLinkArtifacts(endpoint, origin, name);
    const kiro = new URL(links.kiroLink);
    expect(kiro.origin).toBe('https://kiro.dev');
    expect(kiro.pathname).toBe('/launch/mcp/add');
    expect(kiro.searchParams.get('name')).toBe(name);
    expect(JSON.parse(kiro.searchParams.get('config')!)).toEqual({ url: endpoint, disabled: false, autoApprove: [] });

    const lmStudio = new URL(links.lmStudioLink);
    expect(lmStudio.protocol).toBe('lmstudio:');
    expect(lmStudio.host).toBe('add_mcp');
    expect(lmStudio.searchParams.get('name')).toBe(name);
    expect(JSON.parse(Buffer.from(lmStudio.searchParams.get('config')!, 'base64').toString('utf8'))).toEqual({ url: endpoint });

    const goose = new URL(links.gooseLink);
    expect(goose.protocol).toBe('goose:');
    expect(goose.host).toBe('extension');
    expect(Object.fromEntries(goose.searchParams)).toEqual({
      url: endpoint, type: 'streamable_http', id: name, name, description: 'DollhouseMCP hosted server',
    });

    const cherry = new URL(links.cherryStudioLink);
    expect(cherry.protocol).toBe('cherrystudio:');
    expect(cherry.host).toBe('mcp');
    expect(cherry.pathname).toBe('/install');
    expect(JSON.parse(Buffer.from(cherry.searchParams.get('servers')!, 'base64').toString('utf8'))).toEqual({
      mcpServers: { [name]: { name, type: 'streamableHttp', baseUrl: endpoint } },
    });
    expect(JSON.stringify(links)).not.toMatch(/Authorization|Bearer|token|secret|command|args|headers/i);
  });

  it.each([
    ['foreign origin', 'https://other.example/mcp', origin, name],
    ['query token', `${endpoint}?token=x`, origin, name],
    ['URL credentials', 'https://user:pass@mcp.example.test/mcp', origin, name],
    ['new line', `${endpoint}\n`, origin, name],
    ['shell quote', `${origin}/mcp'`, origin, name],
    ['invalid name', endpoint, origin, 'a&name=other'],
    ['name command substitution', endpoint, origin, 'a$(id)'],
  ])('rejects %s before producing an import link', (_case, url, pageOrigin, connectionName) => {
    expect(() => nativeLinkArtifacts(url, pageOrigin, connectionName)).toThrow();
  });
});

describe('native client guides', () => {
  it('exposes only documented handoffs and preserves a manual path for every client', () => {
    const profile = hostedConnectionProfile(endpoint, origin, name);
    const clients = nativeConnectionClients(profile, origin);
    expect(clients.map(client => client.id)).toEqual(['kiro', 'lm-studio', 'goose', 'cherry-studio']);
    for (const client of clients) {
      const steps = client.routes.flatMap(route => route.steps as Array<{ text: string; href?: string }>);
      expect(client.docsUrl.startsWith('https://')).toBe(true);
      expect(client.availability).toMatch(/qualification/i);
      expect(client.routes.some(route => route.id === 'manual')).toBe(true);
      expect(steps.some(step => step.text.includes('OAuth'))).toBe(true);
    }
    for (const client of clients.slice(0, 2)) {
      expect(client.routes.flatMap(route => route.steps as Array<{ href?: string }>).some(step => 'href' in step)).toBe(true);
    }
    for (const client of clients.slice(2)) {
      expect(client.routes.flatMap(route => route.steps as Array<{ href?: string }>).every(step => !('href' in step))).toBe(true);
    }
  });

  it('revalidates supplied profiles against the page origin and exact transport', () => {
    const valid = hostedConnectionProfile(endpoint, origin, name);
    expect(() => nativeConnectionClients({ ...valid, endpoint: 'https://evil.example/mcp' }, origin)).toThrow();
    expect(() => nativeConnectionClients({ ...valid, endpoint: `${endpoint}?token=x` }, origin)).toThrow();
    expect(() => nativeConnectionClients({ ...valid, connectionName: 'a&url=evil' }, origin)).toThrow();
    expect(() => nativeConnectionClients({ ...valid, transport: 'stdio' }, origin)).toThrow('Unsupported');
    expect(() => nativeConnectionClients({ ...valid, endpoint: `${origin}:443/remote/v2/mcp` }, origin)).toThrow('Non-canonical');
  });
});
