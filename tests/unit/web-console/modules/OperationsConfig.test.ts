import { describe, expect, it } from '@jest/globals';

import { InMemoryOperatorConfigStore } from '../../../../src/storage/operatorConfig/InMemoryOperatorConfigStore.js';
import {
  OperatorConfigurationService,
  projectOperatorConfigSetting,
} from '../../../../src/web-console/index.js';

const NOW = new Date('2026-07-21T12:00:00.000Z');
const ENABLED_KEY = 'enhanced_index.enabled';
const PORT_KEY = 'console.port';

describe('OperatorConfigurationService setting concurrency', () => {
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
});
