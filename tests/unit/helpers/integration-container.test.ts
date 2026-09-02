import { describe, expect, it } from '@jest/globals';

import { createIntegrationContainer } from '../../helpers/integration-container.js';

describe('createIntegrationContainer', () => {
  it('fails teardown when promised production bootstrap never ran', async () => {
    const context = await createIntegrationContainer({
      initializePortfolio: false,
      willRunProductionBootstrap: true,
    });

    await expect(context.dispose()).rejects.toThrow(
      'willRunProductionBootstrap was set, but production bootstrap did not complete',
    );
  });
});
