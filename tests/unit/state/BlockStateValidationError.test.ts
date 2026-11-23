import { expect, it } from '@jest/globals';
import { BlockStateValidationError } from '../../../src/security/BlockStateValidationError.js';
import { validateAgentName } from '../../../src/security/validateAgentName.js';
import { readDangerZoneBlockSnapshot } from '../../../src/state/readDangerZoneBlockSnapshot.js';

it('owns fixed name and shape errors with the shared safe validation type', async () => {
  expect(() => validateAgentName('../invalid', 'restore')).toThrow(BlockStateValidationError);
  const result = await readDangerZoneBlockSnapshot(async () => '{"version":1,"blocks":[]}');
  expect(result).toMatchObject({ status: 'invalid', cause: expect.any(BlockStateValidationError) });
});
it('keeps raw JSON parse errors distinct from fixed validation text', async () => {
  const result = await readDangerZoneBlockSnapshot(async () => '{private-value');
  expect(result).toMatchObject({ status: 'invalid', cause: expect.any(SyntaxError) });
  if (result.status === 'invalid') expect(result.cause).not.toBeInstanceOf(BlockStateValidationError);
});
