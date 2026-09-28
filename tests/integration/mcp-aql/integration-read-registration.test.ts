import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { DollhouseContainer, type HandlerBundle } from '../../../src/di/Container.js';
import { WEB_CONSOLE_SERVICE_NAMES } from '../../../src/web-console/WebConsoleRegistrar.js';
import { AeadSecretEncryptionService } from '../../../src/web-console/security/SecretEncryption.js';
import { InMemoryIntegrationDescriptorStore, InMemoryIntegrationOpenApiSpecStore, InMemoryPortfolioElementStore, InMemoryUserIntegrationStore } from '../../../src/web-console/stores/index.js';
import { env } from '../../../src/config/env.js';

const original = {
  portfolio: process.env.DOLLHOUSE_PORTFOLIO_DIR,
  home: process.env.DOLLHOUSE_HOME_DIR,
  mode: env.MCP_INTERFACE_MODE,
  endpoint: env.MCP_AQL_ENDPOINT_MODE,
};
const containers: DollhouseContainer[] = [];
const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const container of containers.splice(0)) await container.dispose();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  if (original.portfolio === undefined) delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  else process.env.DOLLHOUSE_PORTFOLIO_DIR = original.portfolio;
  if (original.home === undefined) delete process.env.DOLLHOUSE_HOME_DIR;
  else process.env.DOLLHOUSE_HOME_DIR = original.home;
  env.MCP_INTERFACE_MODE = original.mode;
  env.MCP_AQL_ENDPOINT_MODE = original.endpoint;
});

async function create(configured: boolean, mode: 'discrete' | 'mcpaql'): Promise<HandlerBundle> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'integration-read-registration-'));
  directories.push(directory);
  process.env.DOLLHOUSE_PORTFOLIO_DIR = directory;
  process.env.DOLLHOUSE_HOME_DIR = path.join(directory, 'home');
  env.MCP_INTERFACE_MODE = mode;
  const container = new DollhouseContainer();
  containers.push(container);
  await container.preparePortfolio();
  if (configured) {
    const services = {
      [WEB_CONSOLE_SERVICE_NAMES.integrationStore]: new InMemoryUserIntegrationStore(),
      [WEB_CONSOLE_SERVICE_NAMES.integrationDescriptorStore]: new InMemoryIntegrationDescriptorStore(),
      [WEB_CONSOLE_SERVICE_NAMES.integrationOpenApiSpecStore]: new InMemoryIntegrationOpenApiSpecStore(),
      [WEB_CONSOLE_SERVICE_NAMES.portfolioStore]: new InMemoryPortfolioElementStore(),
      [WEB_CONSOLE_SERVICE_NAMES.secretEncryption]: new AeadSecretEncryptionService({ keyId: 'test', key: randomBytes(32) }),
    };
    for (const [name, service] of Object.entries(services)) container.register(name, () => service);
  }
  const server = new Server({ name: 'integration-read-test', version: '1.0.0' }, { capabilities: { tools: {}, resources: {}, logging: {} } });
  servers.push(server);
  return container.createHandlers(server);
}

function names(bundle: HandlerBundle): string[] {
  return bundle.toolRegistry.getAllTools().map(tool => tool.name);
}

describe('Integration READ registration', () => {
  it.each([true, false])('isolates two real containers, configured-first=%s', async configuredFirst => {
    env.MCP_AQL_ENDPOINT_MODE = 'crude';
    const bundles = [await create(configuredFirst, 'mcpaql'), await create(!configuredFirst, 'mcpaql')];
    for (const [index, bundle] of bundles.entries()) {
      const configured = index === 0 ? configuredFirst : !configuredFirst;
      expect(bundle.mcpAqlHandler.operations.getRoute('list_integration_operations') !== undefined).toBe(configured);
      const tools = names(bundle);
      expect(tools).not.toContain('list_operations');
      expect(tools).not.toContain('describe_operation');
      for (const name of ['integration_request', 'ingest_openapi_spec', 'regenerate_integration_skill']) {
        expect(tools.includes(name)).toBe(configured);
      }
      const discovery = await bundle.mcpAqlHandler.handleRead({ operation: 'introspect', params: { query: 'operations' } });
      expect(JSON.stringify(discovery).includes('list_integration_operations')).toBe(configured);
    }
  }, 60_000);

  it('keeps all five static tools in discrete mode and both read handlers operational', async () => {
    const bundle = await create(true, 'discrete');
    expect(names(bundle)).toEqual(expect.arrayContaining([
      'integration_request', 'ingest_openapi_spec', 'regenerate_integration_skill', 'list_operations', 'describe_operation',
    ]));
    for (const name of ['list_operations', 'describe_operation']) {
      const result = await bundle.toolRegistry.getHandler(name)!({ provider: 'missing', operation_id: 'missing' });
      expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, error: { code: expect.any(String) } });
    }
  }, 60_000);
});
