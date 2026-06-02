import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
  createOpenDcrRegistrationHandlers,
  type DcrClientInstance,
  type DcrProvider,
} from '../../../../src/auth/embedded-as/dcrPolicyMiddleware.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { InMemoryRateLimitStore } from '../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';

const DCR_RATE_LIMIT_SCOPE = 'open_dcr_registration';

class FakeClient implements DcrClientInstance {
  static clients = new Map<string, Record<string, unknown>>();

  static adapter = {
    async upsert(id: string, payload: Record<string, unknown>): Promise<void> {
      FakeClient.clients.set(id, payload);
    },
  };

  static async find(id: string): Promise<DcrClientInstance | undefined> {
    const found = FakeClient.clients.get(id);
    return found ? new FakeClient(found) : undefined;
  }

  readonly clientId: string;

  constructor(private readonly payload: Record<string, unknown>) {
    this.clientId = String(payload.client_id);
  }

  metadata(): Record<string, unknown> {
    return this.payload;
  }
}

function makeApp(opts: {
  storage: InMemoryAuthStorageLayer;
  rateLimitStore: InMemoryRateLimitStore;
  trustProxy?: boolean;
}): express.Express {
  FakeClient.clients.clear();
  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy) app.set('trust proxy', true);
  const provider: DcrProvider = { Client: FakeClient };
  app.post('/reg', ...createOpenDcrRegistrationHandlers({
    ensureProvider: async () => provider,
    rateLimitStore: opts.rateLimitStore,
    storage: opts.storage,
  }));
  return app;
}

describe('dcrPolicyMiddleware — issue #2220 open DCR hardening', () => {
  it('registers public clients only and records accepted DCR audit details', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const app = makeApp({ storage, rateLimitStore: new InMemoryRateLimitStore() });

    const res = await request(app)
      .post('/reg')
      .send({
        client_name: 'Example MCP Client',
        redirect_uris: ['https://client.example.com/oauth/callback'],
        client_uri: 'https://vendor.example.net/app',
        token_endpoint_auth_method: 'none',
      })
      .expect(201);

    expect(res.body.client_id).toEqual(expect.stringMatching(/^dcr_/));
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(res.body.client_secret).toBeUndefined();
    expect(res.body.client_secret_expires_at).toBeUndefined();

    const events = await storage.listIdentityEvents({ type: 'auth.dcr.registration_accepted' });
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({
      clientId: res.body.client_id,
      clientName: 'Example MCP Client',
      redirectHosts: ['client.example.com'],
      metadataAuditFindings: [
        {
          type: 'metadata_host_mismatch',
          field: 'client_uri',
          host: 'vendor.example.net',
          redirectHosts: ['client.example.com'],
        },
      ],
    });
  });

  it('rejects secret-bearing DCR metadata and records the rejection', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const app = makeApp({ storage, rateLimitStore: new InMemoryRateLimitStore() });

    const res = await request(app)
      .post('/reg')
      .send({
        redirect_uris: ['https://client.example.com/oauth/callback'],
        token_endpoint_auth_method: 'client_secret_post',
      })
      .expect(400);

    expect(res.body.error).toBe('invalid_client_metadata');
    expect(res.body.error_description).toContain(
      'token_endpoint_auth_method contains unsupported value "client_secret_post"',
    );

    const events = await storage.listIdentityEvents({ type: 'auth.dcr.registration_rejected' });
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({
      redirectHosts: ['client.example.com'],
      tokenEndpointAuthMethod: 'client_secret_post',
      errors: expect.arrayContaining([
        'token_endpoint_auth_method contains unsupported value "client_secret_post"',
      ]),
    });
  });

  it('runs the shared-store limiter before JSON parsing', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const rateLimitStore = new InMemoryRateLimitStore();
    const app = makeApp({ storage, rateLimitStore, trustProxy: true });
    const ip = '203.0.113.40';
    await rateLimitStore.update(
      DCR_RATE_LIMIT_SCOPE,
      ip,
      () => ({ state: { count: 60, windowStartedAt: Date.now() } }),
    );

    const res = await request(app)
      .post('/reg')
      .set('X-Forwarded-For', ip)
      .set('Content-Type', 'application/json')
      .send('{not valid json')
      .expect(429);

    expect(res.body.error).toBe('too_many_requests');
  });

  it('keys rate limits on Express req.ip behind a trusted proxy', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const rateLimitStore = new InMemoryRateLimitStore();
    const app = makeApp({ storage, rateLimitStore, trustProxy: true });
    const ip = '198.51.100.25';

    await request(app)
      .post('/reg')
      .set('X-Forwarded-For', ip)
      .send({
        redirect_uris: ['https://client.example.com/oauth/callback'],
        token_endpoint_auth_method: 'none',
      })
      .expect(201);

    const clientBucket = await rateLimitStore.get<{ count: number }>(DCR_RATE_LIMIT_SCOPE, ip);
    expect(clientBucket?.state.count).toBe(1);
  });
});
