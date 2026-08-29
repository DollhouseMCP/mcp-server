/**
 * WIRED end-to-end proof for issue #2321: a BYO descriptor authored entirely
 * through the console `/api/v1` surface — no store seeding — is immediately
 * connectable and usable by the agent through `integration_request`, and its
 * lifecycle (spec ingest, status, delete) holds together across the real
 * DI composition: console routes → stores → per-request provider resolution
 * → policy-authorized gateway → SSRF-guarded outbound → local upstream.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import {
  API_HOST,
  bootWiredIntegration,
  openApiSpec,
  type WiredHarness,
} from './wiredIntegrationHarness.js';

const BYO_PROVIDER = 'byo-authored';
const BYO_API_KEY = 'byo-authored-api-key-secret';
const DESCRIPTORS_PATH = '/api/v1/me/integrations/descriptors';

function body(result: { body?: unknown }): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

describe('BYO authoring wired end-to-end', () => {
  let harness: WiredHarness;
  let descriptorId: string;

  beforeAll(async () => {
    harness = await bootWiredIntegration();
  }, 30_000);

  afterAll(async () => {
    await harness.dispose();
  });

  it('authors a BYO static-key descriptor through the console API', async () => {
    const created = await harness.callConsoleRoute('POST', DESCRIPTORS_PATH, {
      body: {
        provider: BYO_PROVIDER,
        display_name: 'Authored REST',
        category: 'testing',
        auth_strategy: 'static_api_key',
        api_hosts: [API_HOST],
        static_api_key: {
          injection: { location: 'header', name: 'Authorization', value_prefix: 'Bearer ' },
        },
      },
    });

    expect(created.status).toBe(201);
    expect(body(created)).toMatchObject({
      provider: BYO_PROVIDER,
      ownership: 'byo',
      auth_strategy: 'static_api_key',
      has_client_secret: false,
    });
    descriptorId = body(created).id as string;

    const listed = await harness.callConsoleRoute('GET', DESCRIPTORS_PATH);
    const providers = (body(listed).descriptors as Array<{ provider: string }>).map(item => item.provider);
    expect(providers).toEqual(expect.arrayContaining([BYO_PROVIDER, 'wired-rest']));
  });

  it('ingests the OpenAPI spec through the console API', async () => {
    const ingested = await harness.callConsoleRoute('PUT', `${DESCRIPTORS_PATH}/:id/spec`, {
      params: { id: descriptorId },
      body: { spec: openApiSpec(), source_url: `https://${API_HOST}/openapi.json` },
    });

    expect(ingested.status).toBe(200);
    expect(body(ingested)).toMatchObject({
      descriptor_id: descriptorId,
      provider: BYO_PROVIDER,
      operation_count: 2,
    });
    expect(body(ingested).spec).toBeUndefined();
  });

  it('connects through the parameterized route without any restart', async () => {
    const connected = await harness.callConsoleRoute('POST', '/api/v1/me/integrations/:provider/connect', {
      params: { provider: BYO_PROVIDER },
      body: { api_key: BYO_API_KEY, account_label: 'Wired BYO' },
    });

    expect(connected.status).toBe(200);
    expect(body(connected)).toMatchObject({
      provider: BYO_PROVIDER,
      status: 'connected',
      account_label: 'Wired BYO',
    });
    expect(JSON.stringify(connected.body)).not.toContain(BYO_API_KEY);
  });

  it('serves integration_request for the authored descriptor with the key injected server-side', async () => {
    const envelope = await harness.callViaRegistry('integration_request', {
      provider: BYO_PROVIDER,
      method: 'GET',
      path: '/things/42',
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.result).toMatchObject({
      provider: BYO_PROVIDER,
      host: API_HOST,
      status: 200,
      provenance: { trust: 'untrusted' },
    });
    const upstream = harness.lastRequest();
    expect(upstream).toMatchObject({
      method: 'GET',
      url: '/things/42',
      authorization: `Bearer ${BYO_API_KEY}`,
    });
    expect(JSON.stringify(envelope)).not.toContain(BYO_API_KEY);
  });

  it('derives operations from the authored spec for the agent surface', async () => {
    const operations = await harness.callViaRegistry('list_operations', { provider: BYO_PROVIDER });

    expect(operations.ok).toBe(true);
    expect(operations.result).toMatchObject({
      provider: BYO_PROVIDER,
      descriptorId,
    });
    const ids = ((operations.result as { operations: Array<{ operationId: string }> }).operations)
      .map(operation => operation.operationId);
    expect(ids).toEqual(expect.arrayContaining(['getThing', 'createThing']));
  });

  it('deletes the descriptor and fails the agent surface closed', async () => {
    const disconnected = await harness.callConsoleRoute('DELETE', '/api/v1/me/integrations/:provider', {
      params: { provider: BYO_PROVIDER },
    });
    expect(disconnected.status).toBe(200);
    expect(body(disconnected)).toMatchObject({ status: 'disconnected' });

    const removed = await harness.callConsoleRoute('DELETE', `${DESCRIPTORS_PATH}/:id`, {
      params: { id: descriptorId },
    });
    expect(removed.status).toBe(204);

    await expect(harness.specStore.findByDescriptorId(descriptorId)).resolves.toBeNull();

    const envelope = await harness.callViaRegistry('integration_request', {
      provider: BYO_PROVIDER,
      method: 'GET',
      path: '/things/42',
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({ code: 'integration_descriptor_not_found' });
  });

  it('authors a basic-injection descriptor and drives it through the gateway with an Authorization: Basic header', async () => {
    const basicProvider = 'byo-basic';
    const username = 'account-sid';
    const password = 'auth-token-secret';

    const created = await harness.callConsoleRoute('POST', DESCRIPTORS_PATH, {
      body: {
        provider: basicProvider,
        display_name: 'Basic REST',
        category: 'testing',
        auth_strategy: 'static_api_key',
        api_hosts: [API_HOST],
        static_api_key: { injection: { location: 'basic' } },
      },
    });
    expect(created.status).toBe(201);
    expect(body(created)).toMatchObject({
      static_api_key: { injection: { location: 'basic', name: 'Authorization' } },
    });

    const connected = await harness.callConsoleRoute('POST', '/api/v1/me/integrations/:provider/connect', {
      params: { provider: basicProvider },
      body: { username, password },
    });
    expect(connected.status).toBe(200);
    expect(JSON.stringify(connected.body)).not.toContain(password);

    const envelope = await harness.callViaRegistry('integration_request', {
      provider: basicProvider,
      method: 'GET',
      path: '/things/7',
    });
    expect(envelope.ok).toBe(true);
    const upstream = harness.lastRequest();
    const expectedBasic = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    expect(upstream?.authorization).toBe(`Basic ${expectedBasic}`);
    expect(JSON.stringify(envelope)).not.toContain(password);
  });
});
