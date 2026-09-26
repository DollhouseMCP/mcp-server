import { describe, expect, it } from '@jest/globals';
import { hostedConnectionProfile } from '../../../../src/web-console/ui/connect-config';
import { additionalConnectionClients } from '../../../../src/web-console/ui/connect-extra-clients';

const profile = hostedConnectionProfile('https://mcp.example.test/custom/mcp', 'https://mcp.example.test', 'Research_2');
const clients = additionalConnectionClients(profile);
const byId = (id: string) => clients.find(client => client.id === id)!;
const values = (id: string) => byId(id).routes.flatMap(route => route.steps.map(step => step.value).filter(Boolean));

describe('additional hosted client guides', () => {
  it('has unique, navigable client and route IDs with a documented action or availability status', () => {
    expect(clients.length).toBeGreaterThan(25);
    expect(new Set(clients.map(client => client.id)).size).toBe(clients.length);
    for (const client of clients) {
      expect(client.label).toBeTruthy();
      expect(client.group).toBeTruthy();
      expect(client.summary).toBeTruthy();
      expect(client.docsUrl).toMatch(/^https:\/\//);
      expect(client.routes.length).toBeGreaterThan(0);
      expect(new Set(client.routes.map(route => route.id)).size).toBe(client.routes.length);
      for (const route of client.routes) {
        expect(route.label).toBeTruthy();
        expect(route.steps.length).toBeGreaterThan(0);
        for (const step of route.steps) {
          expect(step.title).toBeTruthy();
          expect(step.text).toBeTruthy();
          if (step.value) expect(step.copyLabel).toBeTruthy();
        }
      }
    }
  });

  it('uses separate documented schemas for Hermes, OpenCode, Junie and Antigravity', () => {
    const hermes = values('hermes').find(value => value?.startsWith('mcp_servers:'))!;
    expect(hermes).toContain('auth: oauth');
    expect(hermes).toContain('Research_2:');
    const openCode = JSON.parse(values('opencode').find(value => value?.startsWith('{'))!);
    expect(openCode.mcp.Research_2).toEqual({ type: 'remote', url: profile.endpoint });
    const junie = JSON.parse(values('junie').find(value => value?.startsWith('{'))!);
    expect(junie.mcpServers.Research_2).toEqual({ url: profile.endpoint });
    const antigravity = JSON.parse(values('antigravity').find(value => value?.startsWith('{'))!);
    expect(antigravity.mcpServers.Research_2).toEqual({ serverUrl: profile.endpoint });
    const openClaw = values('openclaw').find(value => value?.startsWith('openclaw mcp set'))!;
    expect(openClaw).toContain('"transport":"streamable-http"');
    expect(openClaw).toContain('"auth":"oauth"');
  });

  it('keeps personal Copilot and AI Studio distinct from admin or developer MCP routes', () => {
    expect(byId('microsoft-copilot-personal').availability).toContain('No verified');
    expect(byId('microsoft-365-copilot').routes[0].label).toBe('Admin / developer');
    expect(byId('google-ai-studio').availability).toContain('No verified');
    expect(byId('gemini-agent-platform').routes[0].label).toBe('Developer setup');
    expect(byId('xcode-native').summary).not.toMatch(/mcpbridge/);
    expect(byId('hermes').routes.map(route => route.label)).toEqual(['In app', 'Config file']);
    expect(byId('junie').routes[0].label).toBe('In Junie CLI');
    expect(byId('copilot-cli').routes[0].steps[0].text).toContain('/mcp add');
    expect(byId('gemini-cli').routes[0].label).toBe('Terminal');
  });

  it('rejects forged profiles before generating copyable config or commands', () => {
    for (const endpoint of [
      'https://mcp.example.test/mcp?token=secret',
      'https://user:pass@mcp.example.test/mcp',
      "https://mcp.example.test/mcp'",
      'javascript:alert(1)',
    ]) {
      expect(() => additionalConnectionClients({ ...profile, endpoint })).toThrow();
    }
    expect(() => additionalConnectionClients({ ...profile, connectionName: 'x;$(touch /tmp/oops)' })).toThrow();
    expect(() => additionalConnectionClients({ ...profile, transport: 'stdio' })).toThrow();
  });
});
