import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../../helpers/di-mocks.js';
import { ManagerBackedPortfolioElementStore } from '../../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';
import { PortfolioElementUnreadableError, type IPortfolioElementStore } from '../../../../src/web-console/stores/IPortfolioElementStore.js';

import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import {
  InMemoryIntegrationDescriptorStore,
  InMemoryIntegrationOpenApiSpecStore,
  InMemoryPortfolioElementStore,
  InMemoryUserIntegrationStore,
  type IntegrationDescriptorRecord,
  type UserIntegrationRecord,
} from '../../../../src/web-console/stores/index.js';
import {
  IntegrationOperationCatalog,
  type IntegrationOperationCatalogError,
} from '../../../../src/web-console/modules/integrations/IntegrationOperationCatalog.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const DESCRIPTOR_ID = '00000000-0000-4000-8000-000000000002';
const INTEGRATION_ID = '00000000-0000-4000-8000-000000000003';
const SPEC_ID = '00000000-0000-4000-8000-000000000004';
const SPEC_HASH = 'a'.repeat(64);
const GMAIL_READONLY = 'gmail.readonly';
const GMAIL_SEND = 'gmail.send';
const GENERATED_SKILL_NAME = 'using-gmail-integration';
const TIMESTAMP = '2026-06-18T00:00:00Z';

describe('IntegrationOperationCatalog', () => {

  it('refreshes generated content without a spec or scope change', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
    await runAsUser(f.contextTracker, () => f.catalog.createSkill({ provider: 'gmail' }));
    const renamed = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore, descriptor: descriptor({ displayName: 'Renamed Mail' }) });
    expect(await runAsUser(renamed.contextTracker, () => renamed.catalog.updateSkill({ provider: 'gmail' }))).toMatchObject({ outcome: 'updated' });
  });

  it('generates mode-neutral guidance and bounds UTF-8 without breaking characters', async () => {
    const spec = { openapi: '3.0.0', paths: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`/items/${i}`, {
      get: { operationId: `item${i}`, summary: '😀日本語'.repeat(100), responses: {} },
    }])) };
    const f = createCatalog({ scopes: [], spec });
    const result = await runAsUser(f.contextTracker, () => f.catalog.listOperations({ provider: 'gmail', includeSkill: true }));
    expect(result.generatedSkill?.content).toContain('mcp_aql_execute');
    expect(result.generatedSkill?.content).toContain('mcp_aql');
    expect(result.generatedSkill?.byteLength).toBeLessThanOrEqual(12 * 1024);
    expect(result.generatedSkill?.content).not.toContain('�');
    expect(result.generatedSkill?.truncated).toBe(true);
  });

  it('flags each legacy skill read-only and keeps strict regeneration ineligible', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
    await runAsUser(f.contextTracker, async () => {
      await f.catalog.createSkill({ provider: 'gmail' });
      const existing = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
      if (!existing) throw new Error('Missing skill');
      const integration = { ...(existing.metadata.integration as Record<string, unknown>) };
      delete integration.generatedProjectionHash;
      await portfolioStore.update({ userId: USER_ID, type: 'skills', canonicalName: GENERATED_SKILL_NAME, expectedVersion: existing.version,
        metadata: { ...existing.metadata, integration }, now: new Date(TIMESTAMP) });
      const before = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
      const result = await f.catalog.listOperations({ provider: 'gmail' });
      expect(result.skillStatus).toContainEqual(expect.objectContaining({ skill_name: GENERATED_SKILL_NAME, status: 'legacy', guidance: expect.stringContaining('create_integration_skill') }));
      expect(await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME)).toEqual(before);
      await expect(f.catalog.updateSkill({ provider: 'gmail' })).rejects.toThrow('different skill_name');
    });
  });
  it('names legacy revisions by new content and refuses to skip an edited revision collision', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
    await runAsUser(f.contextTracker, async () => {
      await f.catalog.createSkill({ provider: 'gmail' });
      const existing = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
      if (!existing) throw new Error('Missing generated skill');
      await portfolioStore.update({ userId: USER_ID, type: 'skills', canonicalName: GENERATED_SKILL_NAME,
        expectedVersion: existing.version, content: 'User edits', now: new Date(TIMESTAMP) });
      const revision = await f.catalog.regenerateSkill({ provider: 'gmail' });
      expect(revision.portfolioAction).toBe('created_revision');
      const current = await portfolioStore.findByName(USER_ID, 'skills', revision.portfolioName);
      if (!current) throw new Error('Missing revision');
      await portfolioStore.update({ userId: USER_ID, type: 'skills', canonicalName: current.canonicalName,
        expectedVersion: current.version, content: 'Edited revision', now: new Date(TIMESTAMP) });
      await expect(f.catalog.regenerateSkill({ provider: 'gmail' })).rejects.toThrow('occupied');
      const renamed = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore, descriptor: descriptor({ displayName: 'Different generated content' }) });
      const next = await runAsUser(renamed.contextTracker, () => renamed.catalog.regenerateSkill({ provider: 'gmail' }));
      expect(next.portfolioAction).toBe('created_revision');
      expect(next.portfolioName).not.toBe(revision.portfolioName);
    });
  });


  it('preserves beta skill metadata when spec and scopes are unchanged', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
    await runAsUser(f.contextTracker, async () => {
      await f.catalog.createSkill({ provider: 'gmail' });
      const original = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
      if (!original) throw new Error('Missing skill');
      const integration = { ...(original.metadata.integration as Record<string, unknown>) };
      delete integration.generatedProjectionHash;
      await portfolioStore.update({ userId: USER_ID, type: 'skills', canonicalName: GENERATED_SKILL_NAME,
        expectedVersion: original.version, content: String(original.metadata.instructions),
        metadata: { ...original.metadata, integration, description: 'User description', custom: 'preserve' },
        tags: ['user-tag'], now: new Date(TIMESTAMP) });
      const before = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
      expect(await f.catalog.regenerateSkill({ provider: 'gmail' })).toMatchObject({ portfolioAction: 'skipped' });
      expect(await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME)).toEqual(before);
    });
  });

  it('distinguishes revisions when non-rendered spec or scope inputs change', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
    await runAsUser(f.contextTracker, async () => {
      await f.catalog.createSkill({ provider: 'gmail' });
      const base = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
      if (!base) throw new Error('Missing skill');
      await portfolioStore.update({ userId: USER_ID, type: 'skills', canonicalName: GENERATED_SKILL_NAME,
        expectedVersion: base.version, content: 'Keep user edits', now: new Date(TIMESTAMP) });
      const first = await f.catalog.regenerateSkill({ provider: 'gmail' });
      await f.specStore.upsert({ descriptorId: DESCRIPTOR_ID, spec: { ...openApiSpec(), components: { schemas: { Unused: { type: 'string' } } } },
        specHash: 'b'.repeat(64), createdAt: new Date(TIMESTAMP), updatedAt: new Date(TIMESTAMP) });
      const second = await f.catalog.regenerateSkill({ provider: 'gmail' });
      expect(second.content).toBe(first.content);
      expect(second.portfolioName).not.toBe(first.portfolioName);
      expect(second.portfolioAction).toBe('created_revision');
      const changedScopes = createCatalog({ scopes: [GMAIL_READONLY, 'unrelated.scope'], portfolioStore });
      const third = await runAsUser(changedScopes.contextTracker, () => changedScopes.catalog.regenerateSkill({ provider: 'gmail' }));
      expect(third.content).toBe(first.content);
      expect(third.portfolioName).not.toBe(first.portfolioName);
    });
  });

  it('ignores unrelated unreadable skills when listing operations', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    await portfolioStore.create({ userId: USER_ID, type: 'skills', name: 'unrelated', displayName: 'Unrelated',
      metadata: {}, content: 'invalid', tags: [], now: new Date(TIMESTAMP) });
    const read = jest.spyOn(portfolioStore, 'findByName').mockRejectedValue(new Error('Unparseable unrelated skill'));
    const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
    const result = await runAsUser(f.contextTracker, () => f.catalog.listOperations({ provider: 'gmail' }));
    expect(result.operations.length).toBeGreaterThan(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads generated skills concurrently while retaining their listed order', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
    await runAsUser(f.contextTracker, async () => {
      await f.catalog.createSkill({ provider: 'gmail', skillName: 'first-helper' });
      await f.catalog.createSkill({ provider: 'gmail', skillName: 'second-helper' });
      const expected = await f.catalog.listOperations({ provider: 'gmail' });
      const names = expected.skillStatus.map(skill => skill.skill_name);
      expect(names).toHaveLength(2);
      let releaseFirst = () => {};
      let notifyStarted = () => {};
      const heldRead = new Promise<void>(resolve => { releaseFirst = resolve; });
      const started = new Promise<void>(resolve => { notifyStarted = resolve; });
      const findByName = portfolioStore.findByName.bind(portfolioStore);
      const read = jest.spyOn(portfolioStore, 'findByName').mockImplementation(async (userId, type, name) => {
        if (name === names[0]) {
          notifyStarted();
          await heldRead;
        }
        return findByName(userId, type, name);
      });
      const pending = f.catalog.listOperations({ provider: 'gmail' });
      await started;
      try {
        expect(read.mock.calls.map(call => call[2])).toEqual(names);
      } finally {
        releaseFirst();
      }
      expect((await pending).skillStatus).toEqual(expected.skillStatus);
    });
  });

  it.each([true, false])('isolates content unreadability but propagates storage failures: unreadable=%s', async unreadable => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
    await runAsUser(f.contextTracker, async () => {
      await f.catalog.createSkill({ provider: 'gmail' });
      const error = unreadable ? new PortfolioElementUnreadableError(new Error('Invalid content')) : new Error('Storage unavailable');
      jest.spyOn(portfolioStore, 'findByName').mockRejectedValue(error);
      const result = f.catalog.listOperations({ provider: 'gmail' });
      if (unreadable) await expect(result).resolves.toMatchObject({
        skillStatus: [{ skill_name: GENERATED_SKILL_NAME, status: 'unreadable' }],
      });
      else await expect(result).rejects.toBe(error);
    });
  });
  it('derives scope-aware operation availability from the stored OpenAPI spec', async () => {
    const { catalog, contextTracker } = createCatalog({ scopes: [GMAIL_READONLY] });

    const result = await runAsUser(contextTracker, () => catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
      includeSkill: true,
    }));

    expect(result).toMatchObject({
      provider: 'gmail',
      descriptorId: DESCRIPTOR_ID,
      specHash: SPEC_HASH,
      scopeAvailability: {
        enforcement: 'advisory_upstream_oauth_token',
      },
    });
    expect(result.operations.map(operation => ({
      id: operation.operationId,
      available: operation.available,
      requiredScopes: operation.requiredScopes,
    }))).toEqual([
      { id: 'listMessages', available: true, requiredScopes: [GMAIL_READONLY] },
      { id: 'sendMessage', available: false, requiredScopes: [GMAIL_SEND] },
      { id: 'getProfile', available: true, requiredScopes: [] },
    ]);
    expect(result.generatedSkill).toMatchObject({
      name: GENERATED_SKILL_NAME,
      regeneration: {
        source: 'openapi_spec',
        specHash: SPEC_HASH,
        scopeFingerprint: GMAIL_READONLY,
      },
    });
    expect(result.generatedSkill?.byteLength).toBeLessThanOrEqual(12 * 1024);
    expect(result.generatedSkill?.content).toContain('Call mcp_aql_execute or mcp_aql');
    expect(result.generatedSkill?.content).toContain('upstream API enforces OAuth scopes');
    expect(result.generatedSkill?.content).not.toContain('sendMessage');
  });

  it('filters unavailable operations by default', async () => {
    const { catalog, contextTracker } = createCatalog({ scopes: [GMAIL_READONLY] });

    const result = await runAsUser(contextTracker, () => catalog.listOperations({ provider: 'gmail' }));

    expect(result.operations.map(operation => operation.operationId)).toEqual(['listMessages', 'getProfile']);
  });

  it('lists only allowlisted available promoted operations for the current session', async () => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({
        operationPromotion: { operations: ['listMessages', 'sendMessage'] },
      }),
      scopes: [GMAIL_READONLY],
    });

    const result = await runAsUser(contextTracker, () => catalog.listPromotedOperations());

    expect(result.map(operation => operation.operationId)).toEqual(['listMessages']);
    expect(result[0]).toMatchObject({
      gatewayRequest: {
        provider: 'gmail',
        method: 'GET',
        pathTemplate: '/gmail/v1/users/{userId}/messages',
      },
      specContract: {
        descriptorId: DESCRIPTOR_ID,
        specHash: SPEC_HASH,
      },
      scopeAvailability: {
        enforcement: 'advisory_upstream_oauth_token',
      },
    });
  });

  it('treats OpenAPI security requirements as alternatives', async () => {
    const { catalog, contextTracker } = createCatalog({ scopes: ['gmail.metadata'] });

    const result = await runAsUser(contextTracker, () => catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }));

    expect(result.operations.find(operation => operation.operationId === 'listMessages')).toMatchObject({
      available: true,
      requiredScopes: ['gmail.metadata'],
    });
  });

  it('describes an operation with gateway request metadata and spec contract', async () => {
    const { catalog, contextTracker } = createCatalog({ scopes: [GMAIL_READONLY] });

    const result = await runAsUser(contextTracker, () => catalog.describeOperation({
      provider: 'gmail',
      operationId: 'sendMessage',
    }));

    expect(result).toMatchObject({
      operationId: 'sendMessage',
      method: 'POST',
      path: '/gmail/v1/users/{userId}/messages',
      readWriteClass: 'write',
      available: false,
      unavailableReason: 'missing_required_scope',
      requestBody: {
        required: true,
        contentTypes: ['application/json'],
      },
      gatewayRequest: {
        provider: 'gmail',
        method: 'POST',
        pathTemplate: '/gmail/v1/users/{userId}/messages',
      },
      specContract: {
        descriptorId: DESCRIPTOR_ID,
        specHash: SPEC_HASH,
      },
      scopeAvailability: {
        enforcement: 'advisory_upstream_oauth_token',
      },
    });
    expect(result.parameters).toEqual([
      expect.objectContaining({ name: 'userId', in: 'path', required: true }),
    ]);
    expect(result.responses).toEqual([
      expect.objectContaining({ status: '200', contentTypes: ['application/json'] }),
    ]);
  });

  it('resolves local OpenAPI refs for parameters, request bodies, and responses', async () => {
    const { catalog, contextTracker } = createCatalog({
      scopes: [GMAIL_SEND],
      spec: {
        ...openApiSpec(),
        components: {
          parameters: {
            UserId: {
              name: 'userId',
              in: 'path',
              required: true,
              description: 'User id',
              schema: { type: 'string' },
            },
          },
          requestBodies: {
            MessageBody: {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } },
            },
          },
          responses: {
            Message: {
              description: 'Message response',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
          schemas: {
            Message: { type: 'object' },
          },
        },
        paths: {
          '/gmail/v1/users/{userId}/messages': {
            parameters: [{ $ref: '#/components/parameters/UserId' }],
            post: {
              operationId: 'sendMessage',
              security: [{ oauth: [GMAIL_SEND] }],
              requestBody: { $ref: '#/components/requestBodies/MessageBody' },
              responses: {
                200: { $ref: '#/components/responses/Message' },
              },
            },
          },
        },
      },
    });

    const result = await runAsUser(contextTracker, () => catalog.describeOperation({
      provider: 'gmail',
      operationId: 'sendMessage',
    }));

    expect(result.parameters).toEqual([
      expect.objectContaining({
        name: 'userId',
        in: 'path',
        required: true,
        description: 'User id',
      }),
    ]);
    expect(result.requestBody).toEqual({
      required: true,
      contentTypes: ['application/json'],
    });
    expect(result.responses).toEqual([
      {
        status: '200',
        description: 'Message response',
        contentTypes: ['application/json'],
      },
    ]);
  });

  it('fails closed without an authenticated session', async () => {
    const { catalog } = createCatalog({ scopes: [GMAIL_READONLY] });

    await expect(catalog.listOperations({ provider: 'gmail' })).rejects.toMatchObject({
      code: 'integration_operation_session_required',
      status: 401,
    } satisfies Partial<IntegrationOperationCatalogError>);
  });

  it('ingests, normalizes, stores, and hashes a BYO OpenAPI spec', async () => {
    const { catalog, contextTracker, specStore } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });

    const result = await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        paths: {
          '/gmail/v1/users/me/profile': {
            get: { operationId: 'duplicate', responses: { 200: { description: 'ok' } } },
            post: { operationId: 'duplicate', responses: { 200: { description: 'ok' } } },
            trace: { operationId: 'ignoredTrace', responses: { 200: { description: 'ok' } } },
          },
        },
      },
      sourceUrl: 'https://gmail.googleapis.com/openapi.json',
    }));

    expect(result).toMatchObject({
      provider: 'gmail',
      descriptorId: DESCRIPTOR_ID,
      operationCount: 2,
      specHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const stored = await specStore.findByDescriptorId(DESCRIPTOR_ID);
    const paths = stored?.spec.paths as Record<string, Record<string, { operationId: string }>>;
    const pathItem = paths['/gmail/v1/users/me/profile'];
    expect(Object.keys(pathItem).sort((left, right) => left.localeCompare(right))).toEqual(['get', 'post']);
    expect(pathItem.get.operationId).toBe('duplicate');
    expect(pathItem.post.operationId).toBe('duplicate_2');
  });

  it('generates stable operation ids for paths containing punctuation and parameters', async () => {
    const { catalog, contextTracker, specStore } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });

    await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        openapi: '3.1.0',
        info: { title: 'Reports', version: '1.0.0' },
        paths: {
          '/reports/{report-id}/daily.v1': {
            get: { responses: { 200: { description: 'ok' } } },
          },
        },
      },
    }));

    const stored = await specStore.findByDescriptorId(DESCRIPTOR_ID);
    const paths = stored?.spec.paths as Record<string, Record<string, { operationId: string }>>;
    expect(paths['/reports/{report-id}/daily.v1'].get.operationId)
      .toBe('get_reports_report_id_daily_v1');
  });

  it('rejects curated spec ingestion through the self-service path', async () => {
    const { catalog, contextTracker } = createCatalog({ scopes: [GMAIL_READONLY] });

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: openApiSpec(),
    }))).rejects.toMatchObject({
      code: 'integration_openapi_ingest_forbidden',
      status: 403,
    });
  });

  it('rejects non-local refs and server hosts outside descriptor apiHosts', async () => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        components: { schemas: { External: { $ref: 'schemas.yaml#/External' } } },
      },
    }))).rejects.toMatchObject({ code: 'invalid_openapi_spec' });

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        servers: [{ url: 'https://evil.example.com' }],
      },
    }))).rejects.toMatchObject({ code: 'invalid_openapi_spec' });
  });

  it('rejects OpenAPI paths longer than the execution policy can evaluate', async () => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        openapi: '3.1.0',
        info: { title: 'Oversized path', version: '1.0.0' },
        paths: {
          [`/${'a'.repeat(1000)}`]: {
            get: { responses: { 200: { description: 'ok' } } },
          },
        },
      },
    }))).rejects.toMatchObject({
      code: 'invalid_openapi_spec',
      status: 400,
    });
  });

  it.each([
    ['protocol-relative', '//evil.example.com/messages'],
    ['backslash-bearing', String.raw`/gmail\v1/messages`],
  ])('rejects %s OpenAPI operation paths during ingestion', async (_label, unsafePath) => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        paths: {
          [unsafePath]: {
            get: { operationId: 'unsafe', responses: { 200: { description: 'ok' } } },
          },
        },
      },
    }))).rejects.toMatchObject({
      code: 'invalid_openapi_spec',
      message: expect.stringContaining('absolute paths'),
    });
  });

  it('does not expose operations for a revoked connected integration', async () => {
    const revoked = {
      ...integration([GMAIL_READONLY]),
      revokedAt: new Date(TIMESTAMP),
    };
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ operationPromotion: { operations: ['listMessages'] } }),
      scopes: [GMAIL_READONLY],
      integration: revoked,
    });

    await expect(runAsUser(contextTracker, () => catalog.listOperations({ provider: 'gmail' })))
      .rejects.toMatchObject({
        code: 'integration_operation_connection_required',
        status: 403,
      });
    await expect(runAsUser(contextTracker, () => catalog.listPromotedOperations()))
      .resolves.toEqual([]);
  });

  it('accepts an equivalent canonical spelling of an allowlisted OpenAPI server host', async () => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({
        ownership: 'byo',
        ownerUserId: USER_ID,
        apiHosts: ['gmail.googleapis.com'],
      }),
      scopes: [GMAIL_READONLY],
    });

    const result = await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        servers: [{ url: 'https://GMAIL.GOOGLEAPIS.COM./' }],
      },
    }));

    expect(result.operationCount).toBeGreaterThan(0);
  });

  it('rejects specs nested past the external-ref scan depth instead of skipping the check', async () => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });

    // An external $ref buried under 45 allOf wrappers sits past the scanner's
    // depth limit of 40; the spec must be rejected outright, not silently pass.
    let nested: Record<string, unknown> = { $ref: 'https://evil.example.com/schema.json#/External' };
    for (let wrap = 0; wrap < 45; wrap += 1) {
      nested = { allOf: [nested] };
    }

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        components: { schemas: { Deep: nested } },
      },
    }))).rejects.toMatchObject({
      code: 'invalid_openapi_spec',
      message: expect.stringContaining('nesting depth'),
    });
  });

  it('regenerates skill helpers while preserving user edits as a new revision', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore([{
      userId: USER_ID,
      type: 'skills',
      name: GENERATED_SKILL_NAME,
      canonicalName: GENERATED_SKILL_NAME,
      displayName: 'User edited Gmail helper',
      version: 1,
      updatedAt: new Date('2026-06-17T00:00:00Z'),
      validationStatus: 'valid',
      tags: [],
      metadata: { name: GENERATED_SKILL_NAME, source: 'user' },
      content: 'my custom instructions',
    }]);
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
      portfolioStore,
    });

    const result = await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: openApiSpec(),
      regenerateSkill: true,
    }));

    expect(result.generatedSkill).toMatchObject({
      written: true,
      portfolioAction: 'created_revision',
      portfolioName: expect.stringMatching(/^using-gmail-integration-[a-f0-9]{12}$/u),
    });
    await expect(portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME))
      .resolves.toMatchObject({ content: 'my custom instructions' });
    await expect(portfolioStore.findByName(USER_ID, 'skills', result.generatedSkill?.portfolioName ?? ''))
      .resolves.toMatchObject({
        metadata: expect.objectContaining({ source: 'integration_openapi_spec' }),
        tags: expect.arrayContaining(['integration-generated', 'integration:gmail']),
    });
  });

  it('preserves edited managed skill content by creating a revision', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore([{
      userId: USER_ID,
      type: 'skills',
      name: GENERATED_SKILL_NAME,
      canonicalName: GENERATED_SKILL_NAME,
      displayName: null,
      version: 2,
      updatedAt: new Date('2026-06-17T00:00:00Z'),
      validationStatus: 'valid',
      tags: ['integration-generated', 'integration:gmail'],
      metadata: {
        name: GENERATED_SKILL_NAME,
        instructions: 'original generated instructions',
        source: 'integration_openapi_spec',
        integration: {
          provider: 'gmail',
          descriptorId: DESCRIPTOR_ID,
          specHash: SPEC_HASH,
          scopeFingerprint: GMAIL_READONLY,
          generated: true,
        },
      },
      content: 'user-edited managed instructions',
    }]);
    const { catalog, contextTracker } = createCatalog({
      scopes: [GMAIL_READONLY, GMAIL_SEND],
      portfolioStore,
    });

    const result = await runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' }));

    expect(result).toMatchObject({
      written: true,
      portfolioAction: 'created_revision',
      portfolioName: expect.stringMatching(/^using-gmail-integration-[a-f0-9]{12}$/u),
    });
    await expect(portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME))
      .resolves.toMatchObject({ content: 'user-edited managed instructions' });
  });

  it('updates an untouched managed skill in place when granted scopes change', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const initial = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
    await runAsUser(initial.contextTracker, () => initial.catalog.regenerateSkill({ provider: 'gmail' }));
    const expanded = createCatalog({ scopes: [GMAIL_READONLY, GMAIL_SEND], portfolioStore });

    const result = await runAsUser(expanded.contextTracker, () => expanded.catalog.regenerateSkill({ provider: 'gmail' }));

    expect(result).toMatchObject({
      written: true,
      portfolioAction: 'updated',
      portfolioName: GENERATED_SKILL_NAME,
    });
    await expect(portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME))
      .resolves.toMatchObject({
        version: 2,
        metadata: expect.objectContaining({ instructions: expect.stringContaining('sendMessage') }),
      });
  });

  it('regenerates the stored-spec skill after granted scopes change', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const { catalog, contextTracker } = createCatalog({
      scopes: [GMAIL_READONLY, GMAIL_SEND],
      portfolioStore,
    });

    const result = await runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' }));

    expect(result).toMatchObject({
      written: true,
      portfolioAction: 'created',
      portfolioName: GENERATED_SKILL_NAME,
      regeneration: {
        scopeFingerprint: 'gmail.readonly gmail.send',
      },
    });
    await expect(portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME))
      .resolves.toMatchObject({
        metadata: expect.objectContaining({
          instructions: expect.stringContaining('sendMessage'),
          integration: expect.objectContaining({
            generatedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      });
  });
});

describe('strict integration management', () => {
  const cleanupDirs: string[] = [];
  afterEach(() => {
    for (const directory of cleanupDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  function generatedStore(managerBacked: boolean): IPortfolioElementStore {
    if (!managerBacked) return new InMemoryPortfolioElementStore();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-skill-review-'));
    cleanupDirs.push(directory);
    const suite = createRealManagerSuite(directory);
    return new ManagerBackedPortfolioElementStore({ getCurrentUserId: () => USER_ID, managers: {
      personas: suite.personaManager, skills: suite.skillManager, templates: suite.templateManager,
      agents: suite.agentManager, memories: suite.memoryManager, ensembles: suite.ensembleManager,
    } });
  }

  describe.each([false, true])('full edit protection (manager-backed: %s)', managerBacked => {
    it.each(['description', 'tags', 'custom', 'gatekeeper', 'triggers', 'displayName'] as const)('preserves %s edits before no-op and regeneration', async field => {
      const portfolioStore = generatedStore(managerBacked);
      const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
      await runAsUser(f.contextTracker, async () => {
        await f.catalog.createSkill({ provider: 'gmail' });
        const existing = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
        if (!existing) throw new Error('Missing generated skill');
        const metadata = { ...existing.metadata,
          ...(field === 'description' ? { description: 'My description' } : {}),
          ...(field === 'custom' ? { custom: { keep: 'my metadata' } } : {}),
          ...(field === 'gatekeeper' ? { gatekeeper: { deny: ['delete_element'] } } : {}),
          ...(field === 'triggers' ? { triggers: ['review'] } : {}),
        };
        const edited = await portfolioStore.update({ userId: USER_ID, type: 'skills', canonicalName: GENERATED_SKILL_NAME,
          expectedVersion: existing.version, expectedContentHash: existing.contentHash, metadata,
          ...(field === 'tags' ? { tags: ['my-tag'] } : {}),
          ...(field === 'displayName' ? { displayName: 'My Helper' } : {}), now: new Date(TIMESTAMP) });
        if (!edited) throw new Error('Missing edited skill');
        const target = edited.canonicalName;
        const before = await portfolioStore.findByName(USER_ID, 'skills', target);
        for (const specHash of [SPEC_HASH, 'b'.repeat(64)]) {
          await f.specStore.upsert({ descriptorId: DESCRIPTOR_ID, spec: openApiSpec(), specHash, createdAt: new Date(TIMESTAMP), updatedAt: new Date(TIMESTAMP) });
          await expect(f.catalog.updateSkill({ provider: 'gmail', skillName: target })).rejects.toThrow('different skill_name');
          expect(await portfolioStore.findByName(USER_ID, 'skills', target)).toEqual(before);
        }
      });
    });

    it.each([
      ['examples', [{ title: 'My example', description: 'Keep my example', input: 'hello', output: 'world' }]],
      ['parameters', [{ name: 'recipient', type: 'string', description: 'User-selected recipient', required: true }]],
      ['domains', ['user-domain']], ['languages', ['typescript']], ['prerequisites', ['user-prerequisite']],
      ['complexity', 'advanced'], ['proficiency_level', 75], ['version', '2.0.0'], ['author', 'user-author'],
    ])('protects authored %s instead of treating it as a constructor default', async (field, value) => {
      const portfolioStore = generatedStore(managerBacked);
      const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
      await runAsUser(f.contextTracker, async () => {
        await f.catalog.createSkill({ provider: 'gmail' });
        const existing = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
        if (!existing) throw new Error('Missing generated skill');
        await portfolioStore.update({ userId: USER_ID, type: 'skills', canonicalName: GENERATED_SKILL_NAME,
          expectedVersion: existing.version, expectedContentHash: existing.contentHash,
          metadata: { ...existing.metadata, [field as string]: value }, now: new Date(TIMESTAMP) });
        const before = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
        for (const specHash of [SPEC_HASH, 'b'.repeat(64)]) {
          await f.specStore.upsert({ descriptorId: DESCRIPTOR_ID, spec: openApiSpec(), specHash,
            createdAt: new Date(TIMESTAMP), updatedAt: new Date(TIMESTAMP) });
          await expect(f.catalog.updateSkill({ provider: 'gmail' })).rejects.toThrow('different skill_name');
          expect(await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME)).toEqual(before);
        }
      });
    });

    it.each(['absent', 'explicit'])('ignores serializer-owned changes with %s constructor defaults', async defaults => {
      const portfolioStore = generatedStore(managerBacked);
      const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
      await runAsUser(f.contextTracker, async () => {
        await f.catalog.createSkill({ provider: 'gmail' });
        const existing = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
        if (!existing) throw new Error('Missing generated skill');
        const metadata = { ...existing.metadata, created: '2026-09-29T00:00:00Z', type: 'skill', format_version: 'v2' };
        const constructorDefaults = { version: '1.0.0', author: 'integration-generator', languages: [], complexity: 'beginner',
          domains: [], prerequisites: [], parameters: [], examples: [], proficiency_level: 0 };
        for (const [key, value] of Object.entries(constructorDefaults)) {
          // Generated author/version are explicit fields, not supplied by the manager's defaults.
          if (defaults === 'explicit' || key === 'author' || key === 'version') metadata[key] = value;
          else delete metadata[key];
        }
        await portfolioStore.update({ userId: USER_ID, type: 'skills', canonicalName: GENERATED_SKILL_NAME,
          expectedVersion: existing.version, expectedContentHash: existing.contentHash,
          metadata, now: new Date(TIMESTAMP) });
        expect(await f.catalog.updateSkill({ provider: 'gmail' })).toMatchObject({ outcome: 'no-op' });
        await f.specStore.upsert({ descriptorId: DESCRIPTOR_ID, spec: openApiSpec(), specHash: 'b'.repeat(64),
          createdAt: new Date(TIMESTAMP), updatedAt: new Date(TIMESTAMP) });
        expect(await f.catalog.updateSkill({ provider: 'gmail' })).toMatchObject({ outcome: 'updated' });
      });
    });

    it('keeps unedited skills eligible after descriptor rename in strict and discrete regeneration', async () => {
      const portfolioStore = generatedStore(managerBacked);
      const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
      await runAsUser(f.contextTracker, () => f.catalog.createSkill({ provider: 'gmail' }));
      const renamed = createCatalog({ scopes: [GMAIL_READONLY, GMAIL_SEND], portfolioStore, descriptor: descriptor({ displayName: 'Renamed Mail' }) });
      await runAsUser(renamed.contextTracker, async () => {
        expect(await renamed.catalog.updateSkill({ provider: 'gmail' })).toMatchObject({ outcome: 'updated' });
      });
      expect(await runAsUser(f.contextTracker, () => f.catalog.regenerateSkill({ provider: 'gmail' }))).toMatchObject({ portfolioAction: 'updated' });
      expect(await portfolioStore.listByUser(USER_ID)).toHaveLength(1);
    });
  });

  it('returns usable content hashes and rejects stale tokens with a real manager whose version stays one', async () => {
    const portfolioStore = generatedStore(true);
    const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
    await runAsUser(f.contextTracker, async () => {
      const created = await f.catalog.createSkill({ provider: 'gmail' });
      expect(created.content_hash).toMatch(/^[a-f0-9]{64}$/u);
      await f.specStore.upsert({ descriptorId: DESCRIPTOR_ID, spec: openApiSpec(), specHash: 'b'.repeat(64),
        createdAt: new Date(TIMESTAMP), updatedAt: new Date(TIMESTAMP) });
      const updated = await f.catalog.updateSkill({ provider: 'gmail', expectedContentHash: created.content_hash });
      expect(updated.content_hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(updated.content_hash).not.toBe(created.content_hash);
      const before = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
      expect(before?.version).toBe(1);
      await expect(f.catalog.updateSkill({ provider: 'gmail', expectedContentHash: created.content_hash }))
        .rejects.toThrow(`current_content_hash=${updated.content_hash}`);
      expect(await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME)).toEqual(before);
      expect(await f.catalog.updateSkill({ provider: 'gmail', expectedContentHash: updated.content_hash }))
        .toMatchObject({ outcome: 'no-op', content_hash: updated.content_hash });
    });
  });

  it.each(['edit', 'same-byte-replacement'] as const)('preserves %s committed after the generated update post-hash check', async race => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-skill-posthash-review-'));
    cleanupDirs.push(directory);
    const suite = createRealManagerSuite(directory);
    const portfolioStore = new ManagerBackedPortfolioElementStore({ getCurrentUserId: () => USER_ID, managers: {
      personas: suite.personaManager, skills: suite.skillManager, templates: suite.templateManager,
      agents: suite.agentManager, memories: suite.memoryManager, ensembles: suite.ensembleManager,
    } });
    const f = createCatalog({ scopes: [GMAIL_READONLY], portfolioStore });
    await runAsUser(f.contextTracker, async () => {
      await f.catalog.createSkill({ provider: 'gmail' });
      await f.specStore.upsert({ descriptorId: DESCRIPTOR_ID, spec: openApiSpec(), specHash: 'b'.repeat(64),
        createdAt: new Date(TIMESTAMP), updatedAt: new Date(TIMESTAMP) });
      let enter!: () => void; let release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const originalImport = suite.skillManager.importElement.bind(suite.skillManager);
      const spy = jest.spyOn(suite.skillManager, 'importElement').mockImplementationOnce(async (...args) => {
        enter(); await barrier; return originalImport(...args);
      });
      const pending = f.catalog.updateSkill({ provider: 'gmail' });
      await entered; // Store has already accepted the old expectedContentHash.
      try {
        const beforeEdit = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
        if (!beforeEdit) throw new Error('Expected generated skill');
        if (race === 'edit') {
          await portfolioStore.update({ userId: USER_ID, type: 'skills', canonicalName: beforeEdit.canonicalName,
            expectedContentHash: beforeEdit.contentHash, content: 'USER EDIT COMMITTED AFTER HASH CHECK',
            metadata: { ...beforeEdit.metadata, instructions: 'USER EDIT COMMITTED AFTER HASH CHECK' }, now: new Date(TIMESTAMP) });
          expect((await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME))?.content)
            .toContain('USER EDIT COMMITTED AFTER HASH CHECK');
        } else {
          const skillPath = path.join(directory, 'skills', fs.readdirSync(path.join(directory, 'skills')).find(name => name.endsWith('.md'))!);
          const originalBytes = fs.readFileSync(skillPath);
          fs.renameSync(skillPath, path.join(directory, 'held-original-skill'));
          fs.writeFileSync(skillPath, originalBytes);
        }
      } finally { release(); spy.mockRestore(); }
      await expect(pending).rejects.toThrow('expected_content_hash');
      const after = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
      if (race === 'edit') expect(after?.content).toContain('USER EDIT COMMITTED AFTER HASH CHECK');
      else expect(after?.metadata.integration).toMatchObject({ specHash: SPEC_HASH });
    });
  });

  function strictFixture() {
    const portfolioStore = new InMemoryPortfolioElementStore();
    return { ...createCatalog({ scopes: [GMAIL_READONLY], portfolioStore,
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }) }), portfolioStore };
  }

  it('separates spec create/update and never writes a skill', async () => {
    const f = strictFixture();
    await runAsUser(f.contextTracker, async () => {
      const input = { provider: 'gmail', spec: openApiSpec() };
      await expect(f.catalog.createSpec(input)).rejects.toThrow('update_integration_spec');
      await f.specStore.deleteByDescriptorId(DESCRIPTOR_ID);
      await expect(f.catalog.updateSpec(input)).rejects.toThrow('create_integration_spec');
      const created = await f.catalog.createSpec(input);
      expect(created).toMatchObject({ outcome: 'created', operationCount: 3 });
      await expect(f.catalog.updateSpec({ ...input, expectedSpecHash: SPEC_HASH })).rejects.toThrow('list_integration_operations');
      expect(await f.catalog.updateSpec({ ...input, expectedSpecHash: created.specHash })).toMatchObject({ outcome: 'updated' });
      expect(await f.portfolioStore.listByUser(USER_ID)).toEqual([]);
    });
  });

  it('creates explicit skill targets, refuses collisions, and updates only managed existing targets', async () => {
    const f = strictFixture();
    await runAsUser(f.contextTracker, async () => {
      const input = { provider: 'gmail', skillName: 'explicit-revision' };
      await expect(f.catalog.updateSkill(input)).rejects.toThrow('create_integration_skill');
      expect(await f.catalog.createSkill(input)).toMatchObject({ outcome: 'created', skill_name: input.skillName });
      await expect(f.catalog.createSkill(input)).rejects.toThrow('update_integration_skill');
      const existing = await f.portfolioStore.findByName(USER_ID, 'skills', input.skillName);
      if (!existing) throw new Error('Missing test skill');
      f.portfolioStore.set({ ...existing, contentHash: 'd'.repeat(64) });
      await expect(f.catalog.updateSkill({ ...input, expectedContentHash: 'c'.repeat(64) })).rejects.toThrow(`current_content_hash=${'d'.repeat(64)}`);
      expect(await f.catalog.updateSkill({ ...input, expectedContentHash: 'd'.repeat(64) })).toMatchObject({ outcome: 'no-op', content_hash: 'd'.repeat(64) });
      expect(await f.catalog.updateSkill(input)).toMatchObject({ outcome: 'no-op', skill_name: input.skillName });
      await f.specStore.upsert({ descriptorId: DESCRIPTOR_ID, spec: openApiSpec(), specHash: 'b'.repeat(64), createdAt: new Date(TIMESTAMP), updatedAt: new Date(TIMESTAMP) });
      expect(await f.catalog.updateSkill(input)).toMatchObject({ outcome: 'updated', skill_name: input.skillName });
      expect(await f.catalog.createSkill({ provider: 'gmail' })).toMatchObject({ outcome: 'created', skill_name: GENERATED_SKILL_NAME });
      expect((await f.portfolioStore.listByUser(USER_ID)).map(row => row.name).sort()).toEqual([input.skillName, GENERATED_SKILL_NAME].sort());
    });
  });

  it.each(['edited', 'unmanaged'] as const)('preserves %s skills even when their spec is current', async kind => {
    const f = strictFixture();
    await runAsUser(f.contextTracker, async () => {
      await f.catalog.createSkill({ provider: 'gmail' });
      const existing = await f.portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
      if (!existing) throw new Error('Missing test skill');
      await f.portfolioStore.update({ userId: USER_ID, type: 'skills', canonicalName: GENERATED_SKILL_NAME,
        expectedVersion: existing.version, content: 'preserve my work',
        ...(kind === 'unmanaged' ? { metadata: {} } : {}), now: new Date(TIMESTAMP) });
      const before = await f.portfolioStore.listByUser(USER_ID);
      for (const action of ['createSkill', 'updateSkill'] as const) {
        await expect(f.catalog[action]({ provider: 'gmail' })).rejects.toThrow('different skill_name');
      }
      expect(await f.portfolioStore.listByUser(USER_ID)).toEqual(before);
      expect((await f.portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME))?.content).toBe('preserve my work');
    });
  });

  it.each(['unchanged', 'body-edited', 'instructions-edited'] as const)('handles the manager-rendered reference card when %s', async state => {
    const f = strictFixture();
    await runAsUser(f.contextTracker, async () => {
      await f.catalog.createSkill({ provider: 'gmail' });
      const skill = await f.portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
      if (!skill) throw new Error('Missing test skill');
      const body = `# ${GENERATED_SKILL_NAME}\n\n${skill.metadata.description}\n`;
      await f.portfolioStore.update({ userId: USER_ID, type: 'skills', canonicalName: GENERATED_SKILL_NAME,
        expectedVersion: skill.version, content: state === 'body-edited' ? `${body}My notes` : body,
        metadata: state === 'instructions-edited' ? { ...skill.metadata, instructions: 'my instructions' } : skill.metadata,
        now: new Date(TIMESTAMP) });
      if (state === 'unchanged') expect(await f.catalog.updateSkill({ provider: 'gmail' })).toMatchObject({ outcome: 'no-op' });
      else await expect(f.catalog.updateSkill({ provider: 'gmail' })).rejects.toThrow('different skill_name');
    });
  });

  it.each(['deleted', 'edited'] as const)('preserves a skill %s between lookup and update without creating a revision', async race => {
    const f = strictFixture();
    await runAsUser(f.contextTracker, async () => {
      await f.catalog.createSkill({ provider: 'gmail' });
      await f.specStore.upsert({ descriptorId: DESCRIPTOR_ID, spec: openApiSpec(), specHash: 'b'.repeat(64), createdAt: new Date(TIMESTAMP), updatedAt: new Date(TIMESTAMP) });
      const original = f.portfolioStore.update.bind(f.portfolioStore);
      jest.spyOn(f.portfolioStore, 'update').mockImplementationOnce(async input => {
        if (race === 'deleted') await f.portfolioStore.delete(input);
        else await original({ ...input, content: 'concurrent edit', metadata: {} });
        return original(input);
      });
      await expect(f.catalog.updateSkill({ provider: 'gmail' })).rejects.toThrow(race === 'deleted' ? 'create_integration_skill' : 'expected_content_hash');
      const skills = await f.portfolioStore.listByUser(USER_ID);
      expect(skills).toHaveLength(race === 'deleted' ? 0 : 1);
      if (race === 'edited') {
        expect((await f.portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME))?.content).toBe('concurrent edit');
      }
    });
  });

  it('allows skill generation from curated descriptors but forbids their spec writes', async () => {
    const f = createCatalog({ scopes: [GMAIL_READONLY] });
    await runAsUser(f.contextTracker, async () => {
      expect(await f.catalog.createSkill({ provider: 'gmail' })).toMatchObject({ outcome: 'created' });
      await expect(f.catalog.updateSpec({ provider: 'gmail', spec: openApiSpec() })).rejects.toMatchObject({ status: 403 });
    });
  });
});

function createCatalog(options: {
  readonly scopes: readonly string[];
  readonly descriptor?: IntegrationDescriptorRecord;
  readonly portfolioStore?: IPortfolioElementStore;
  readonly spec?: Readonly<Record<string, unknown>>;
  readonly integration?: UserIntegrationRecord;
}) {
  const contextTracker = new ContextTracker();
  const descriptorStore = new InMemoryIntegrationDescriptorStore([options.descriptor ?? descriptor()]);
  const specStore = new InMemoryIntegrationOpenApiSpecStore([{
    id: SPEC_ID,
    descriptorId: DESCRIPTOR_ID,
    spec: options.spec ?? openApiSpec(),
    sourceUrl: 'https://gmail.googleapis.com/openapi.json',
    specHash: SPEC_HASH,
    createdAt: new Date(TIMESTAMP),
    updatedAt: new Date(TIMESTAMP),
  }]);
  const integrationStore = new InMemoryUserIntegrationStore([options.integration ?? integration(options.scopes)]);
  return {
    contextTracker,
    catalog: new IntegrationOperationCatalog({
      descriptorStore,
      specStore,
      integrationStore,
      contextTracker,
      portfolioStore: options.portfolioStore ?? new InMemoryPortfolioElementStore(),
      now: () => new Date(TIMESTAMP),
    }),
    specStore,
  };
}

function descriptor(overrides: Partial<IntegrationDescriptorRecord> = {}): IntegrationDescriptorRecord {
  return {
    id: DESCRIPTOR_ID,
    provider: 'gmail',
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Gmail',
    category: 'email',
    authStrategy: 'oauth2_authorization_code',
    apiHosts: ['gmail.googleapis.com'],
    oauth: {
      clientId: 'gmail-client',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: [GMAIL_READONLY, GMAIL_SEND],
      pkce: 'required',
      refresh: 'rotating',
      tokenExchange: {},
      accountLabel: {},
    },
    staticApiKey: null,
    clientSecretCiphertext: Buffer.from('encrypted-client-secret'),
    clientSecretRevision: '00000000-0000-4000-8000-000000000201',
    credentialKeyVersion: 'v1',
    operationPromotion: {},
    createdAt: new Date(TIMESTAMP),
    updatedAt: new Date(TIMESTAMP),
    ...overrides,
  };
}

function integration(scopes: readonly string[]): UserIntegrationRecord {
  return {
    id: INTEGRATION_ID,
    userId: USER_ID,
    provider: 'gmail',
    integrationDescriptorId: DESCRIPTOR_ID,
    externalAccountLabel: 'alice@example.com',
    externalInstallationId: null,
    authorizedPermissions: { scopes },
    accessTokenCiphertext: Buffer.from('encrypted-access-token'),
    refreshTokenCiphertext: Buffer.from('encrypted-refresh-token'),
    credentialKeyVersion: 'v1',
    status: 'connected',
    errorReason: null,
    cleanupAttemptCount: 0,
    cleanupNextAttemptAt: null,
    cleanupLeaseId: null,
    cleanupLeaseExpiresAt: null,
    connectedAt: new Date(TIMESTAMP),
    lastSyncAt: null,
    revokedAt: null,
  };
}

function openApiSpec(): Readonly<Record<string, unknown>> {
  return {
    openapi: '3.1.0',
    info: { title: 'Gmail fixture', version: '1.0.0' },
    security: [{ oauth: [GMAIL_READONLY] }],
    paths: {
      '/gmail/v1/users/{userId}/messages': {
        parameters: [{
          name: 'userId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        }],
        get: {
          operationId: 'listMessages',
          summary: 'List messages',
          security: [
            { oauth: [GMAIL_READONLY] },
            { oauth: ['gmail.metadata'] },
          ],
          responses: {
            200: {
              description: 'Message list',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
        post: {
          operationId: 'sendMessage',
          summary: 'Send a message',
          security: [{ oauth: [GMAIL_SEND] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            200: {
              description: 'Sent message',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/gmail/v1/users/me/profile': {
        get: {
          operationId: 'getProfile',
          summary: 'Get profile',
          security: [],
          responses: { 200: { description: 'Profile' } },
        },
      },
    },
  };
}

function runAsUser<T>(contextTracker: ContextTracker, fn: () => Promise<T>): Promise<T> {
  return contextTracker.runAsync({
    type: 'test',
    requestId: 'req-1',
    timestamp: Date.now(),
    session: {
      userId: USER_ID,
      sessionId: 'session-1',
      tenantId: null,
      transport: 'http',
      createdAt: Date.now(),
      roles: [],
    },
  }, fn);
}
