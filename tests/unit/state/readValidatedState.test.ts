import { expect, it, jest } from '@jest/globals';
import { readValidatedState } from '../../../src/state/persistence-utils.js';

it('returns validated data', async () => {
  const issue = jest.fn();
  expect(await readValidatedState(async () => '{"version":1,"value":7}', value => value.value, issue)).toBe(7);
  expect(issue).not.toHaveBeenCalled();
});
it('treats absence as empty without reporting a problem', async () => {
  const issue = jest.fn();
  const read = async (): Promise<string> => { throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); };
  expect(await readValidatedState(read, value => value, issue)).toBeUndefined();
  expect(issue).not.toHaveBeenCalled();
});
it.each(['null', '{', '{"version":2}', '{"version":1,"value":false}'])('reports rejected state once: %s', async content => {
  const issue = jest.fn();
  expect(await readValidatedState(async () => content, () => { throw new Error('Invalid'); }, issue)).toBeUndefined();
  expect(issue).toHaveBeenCalledTimes(1);
});
it('reports unreadable state once', async () => {
  const issue = jest.fn();
  const read = async (): Promise<string> => { throw new Error('Unavailable'); };
  expect(await readValidatedState(read, value => value, issue)).toBeUndefined();
  expect(issue).toHaveBeenCalledWith('unreadable');
  expect(issue).toHaveBeenCalledTimes(1);
});
