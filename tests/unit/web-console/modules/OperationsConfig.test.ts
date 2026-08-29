import { describe, expect, it } from '@jest/globals';

import { InMemoryOperatorConfigStore } from '../../../../src/storage/operatorConfig/InMemoryOperatorConfigStore.js';
import {
  OperatorConfigurationService,
  projectOperatorConfigSetting,
  type OperatorConfigSettingDefinition,
} from '../../../../src/web-console/index.js';

const NOW = new Date('2026-07-21T12:00:00.000Z');
const ENABLED_KEY = 'enhanced_index.enabled';
const LICENSE_KEY = 'license.key';
const PORT_KEY = 'console.port';
const READ_ONLY_KEY = 'deployment.region';
const READ_ONLY_DEFINITIONS: readonly OperatorConfigSettingDefinition[] = [{
  key: READ_ONLY_KEY,
  section: 'defaultsConfig',
  path: ['region'],
  schema: { type: 'string', min_length: 1 },
  schemaVersion: 1,
  sensitivity: 'public_admin',
  mutability: 'read_only',
  requiredCapability: 'console:admin:operate',
  defaultValue: 'us-east-1',
}];

describe('OperatorConfigurationService', () => {
  it('keeps a sibling ETag valid when a different setting changes', async () => {
    const service = new OperatorConfigurationService(
      new InMemoryOperatorConfigStore(),
      undefined,
      () => NOW,
    );
    const siblingBefore = projectOperatorConfigSetting((await service.getConfig(PORT_KEY)).body);
    const changedBefore = projectOperatorConfigSetting((await service.getConfig(ENABLED_KEY)).body);

    await expect(service.updateConfig({
      key: ENABLED_KEY,
      ifMatch: changedBefore.etag,
      body: { value: true },
    })).resolves.toMatchObject({ status: 200 });

    const siblingAfter = projectOperatorConfigSetting((await service.getConfig(PORT_KEY)).body);
    expect(siblingAfter.etag).toBe(siblingBefore.etag);
    await expect(service.updateConfig({
      key: PORT_KEY,
      ifMatch: siblingBefore.etag,
      body: { value: 3100 },
    })).resolves.toMatchObject({ status: 200 });
  });

  it('records effective state and rotates the changed dynamic setting ETag', async () => {
    const service = new OperatorConfigurationService(
      new InMemoryOperatorConfigStore(),
      undefined,
      () => NOW,
    );
    const before = projectOperatorConfigSetting((await service.getConfig(ENABLED_KEY)).body);

    const result = await service.updateConfig({
      key: ENABLED_KEY,
      ifMatch: before.etag,
      body: { value: true },
    });
    const updated = projectOperatorConfigSetting(result.body);

    expect(result.status).toBe(200);
    expect(updated).toMatchObject({
      key: ENABLED_KEY,
      value: true,
      effective_at: NOW.toISOString(),
      pending_restart: false,
    });
    expect(updated.etag).not.toBe(before.etag);
  });

  it('rejects malformed and oversized mutations without changing stored configuration', async () => {
    const store = new InMemoryOperatorConfigStore();
    const service = new OperatorConfigurationService(store);
    const initial = await store.load();
    const enabled = projectOperatorConfigSetting((await service.getConfig(ENABLED_KEY)).body);
    const license = projectOperatorConfigSetting((await service.getConfig(LICENSE_KEY)).body);

    await expect(service.updateConfig({
      key: ENABLED_KEY,
      ifMatch: enabled.etag,
      body: {},
    })).resolves.toMatchObject({
      status: 422,
      body: { code: 'validation_failed', detail: 'Request body must be an object with a value field.' },
    });
    await expect(service.updateConfig({
      key: LICENSE_KEY,
      ifMatch: license.etag,
      body: { value: 'x'.repeat(64 * 1024 + 1) },
    })).resolves.toMatchObject({
      status: 422,
      body: { code: 'validation_failed', detail: 'Operator configuration value exceeds the maximum size.' },
    });
    await expect(store.load()).resolves.toEqual(initial);
  });

  it('rejects updates to read-only definitions without changing stored configuration', async () => {
    const store = new InMemoryOperatorConfigStore();
    const service = new OperatorConfigurationService(store, READ_ONLY_DEFINITIONS);
    const initial = await store.load();
    const setting = projectOperatorConfigSetting((await service.getConfig(READ_ONLY_KEY)).body);

    await expect(service.updateConfig({
      key: READ_ONLY_KEY,
      ifMatch: setting.etag,
      body: { value: 'us-west-2' },
    })).resolves.toMatchObject({
      status: 409,
      body: { code: 'config_read_only' },
    });
    await expect(store.load()).resolves.toEqual(initial);
  });
});
