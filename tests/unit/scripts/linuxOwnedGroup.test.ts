import { describe, expect, it } from '@jest/globals';
import { exactOwnedZombies, parseLinuxProcess, sameLinuxProcess, type LinuxProcess } from '../../helpers/linuxOwnedGroup.js';

// Synthetic proc fixtures test conservative refusal on every host. The actual
// Linux subreaper control is the hung-launcher case in ownedFixtureProcess.
const leader: LinuxProcess = { pid: 100, state: 'S', group: 100, session: 100, started: '900', threads: 1 };
const child: LinuxProcess = { ...leader, pid: 101, started: '901' };
const zombie = { ...child, state: 'Z' };

describe('Linux fixture process evidence (synthetic metadata)', () => {
  it('parses comm with closing parentheses without shifting identity fields', () => {
    const fields = ['Z', '1', '100', '100', ...Array.from({ length: 13 }, () => '0'), '1', '0', '901'];
    expect(parseLinuxProcess(`101 (name ) with spaces)) ${fields.join(' ')} 0\n`)).toEqual(zombie);
  });
  it.each(['', '101 name Z 1', '101 (x) Z 1 100 100', `101 (x) Z 1 100 100 ${'0 '.repeat(30)}`])('refuses missing or malformed identity %p', raw => {
    expect(() => parseLinuxProcess(raw)).toThrow();
  });
  it('accepts only exact captured zombies and never describes them as absent', () => {
    expect(exactOwnedZombies([leader, child], [zombie], 100)).toBe(true);
    expect(sameLinuxProcess(child, zombie)).toBe(true);
    expect(exactOwnedZombies([leader, child], [], 100)).toBe(false);
  });
  it.each([
    { state: 'S' }, { state: 'R' }, { state: 'D' }, { state: 'T' }, { state: 'X' },
    { started: '902' }, { pid: 102 }, { group: 102 }, { session: 102 }, { threads: 2 },
  ])('refuses live, unknown, reused or threaded membership %p', change => {
    expect(exactOwnedZombies([leader, child], [{ ...zombie, ...change }], 100)).toBe(false);
  });
  it('refuses an uncaptured member even alongside an exact captured zombie', () => {
    expect(exactOwnedZombies([leader, child], [zombie, { ...zombie, pid: 102 }], 100)).toBe(false);
  });
});
