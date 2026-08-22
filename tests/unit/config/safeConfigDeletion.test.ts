import { describe, expect, it, jest } from '@jest/globals';
import {
  deleteOwnConfigLeaf,
  parseSafeConfigPath,
} from '../../../src/config/safeConfigDeletion.js';

describe('safeConfigDeletion', () => {
  describe('parseSafeConfigPath', () => {
    it.each([
      '__proto__.polluted',
      'user.CONSTRUCTOR.polluted',
      'sync. prototype .polluted',
      'user.%63onstructor.polluted',
      'user.%2563onstructor.polluted',
      'user.ｐｒｏｔｏｔｙｐｅ.polluted',
    ])('rejects dangerous path variant %s', path => {
      expect(() => parseSafeConfigPath(path)).toThrow(/Forbidden property/);
    });

    it.each(['', '.user', 'user.', 'user..name', 'user.%zz'])('rejects malformed path %s', path => {
      expect(() => parseSafeConfigPath(path)).toThrow();
    });

    it('preserves valid custom segments', () => {
      expect(parseSafeConfigPath('display.custom-theme.value')).toEqual([
        'display',
        'custom-theme',
        'value',
      ]);
    });
  });

  describe('deleteOwnConfigLeaf', () => {
    it('rejects dangerous segments even when called without the path parser', () => {
      const root = Object.assign(Object.create(null) as Record<string, unknown>, {
        constructor: 'leave-me-alone',
      });

      expect(() => deleteOwnConfigLeaf(root, ['constructor'])).toThrow(/Forbidden property/);
      expect(root.constructor).toBe('leave-me-alone');
    });

    it('deletes a configurable own data property', () => {
      const root = { custom: { leaf: 'value' } };

      expect(deleteOwnConfigLeaf(root, ['custom', 'leaf'])).toEqual({
        kind: 'deleted',
        previousValue: 'value',
      });
      expect(root.custom).not.toHaveProperty('leaf');
    });

    it('supports null-prototype objects', () => {
      const nested = Object.assign(Object.create(null) as Record<string, unknown>, { leaf: 42 });
      const root = Object.assign(Object.create(null) as Record<string, unknown>, { nested });

      expect(deleteOwnConfigLeaf(root, ['nested', 'leaf'])).toEqual({
        kind: 'deleted',
        previousValue: 42,
      });
      expect(Object.hasOwn(nested, 'leaf')).toBe(false);
    });

    it('treats inherited properties as missing without mutating the prototype', () => {
      const prototype = { leaf: 'inherited' };
      const nested = Object.create(prototype) as Record<string, unknown>;
      const root = { nested };

      expect(deleteOwnConfigLeaf(root, ['nested', 'leaf'])).toEqual({
        kind: 'unsafe',
        reason: 'Configuration path crosses a non-plain object.',
      });
      expect(prototype.leaf).toBe('inherited');
    });

    it('does not follow Object.prototype properties', () => {
      const root = { nested: {} };

      expect(deleteOwnConfigLeaf(root, ['nested', 'toString'])).toEqual({ kind: 'missing' });
      expect(Object.hasOwn(root.nested, 'toString')).toBe(false);
    });

    it('does not invoke an intermediate accessor', () => {
      const getter = jest.fn(() => ({ leaf: 'value' }));
      const root: Record<string, unknown> = {};
      Object.defineProperty(root, 'nested', { configurable: true, get: getter });

      expect(deleteOwnConfigLeaf(root, ['nested', 'leaf'])).toEqual({
        kind: 'unsafe',
        reason: 'Configuration path crosses an accessor property.',
      });
      expect(getter).not.toHaveBeenCalled();
    });

    it('does not invoke or delete a leaf accessor', () => {
      const getter = jest.fn(() => 'value');
      const nested: Record<string, unknown> = {};
      Object.defineProperty(nested, 'leaf', { configurable: true, get: getter });

      expect(deleteOwnConfigLeaf({ nested }, ['nested', 'leaf'])).toEqual({
        kind: 'unsafe',
        reason: 'Configuration leaf is an accessor property.',
      });
      expect(getter).not.toHaveBeenCalled();
      expect(Object.hasOwn(nested, 'leaf')).toBe(true);
    });

    it('rejects non-configurable leaves', () => {
      const nested: Record<string, unknown> = {};
      Object.defineProperty(nested, 'leaf', { configurable: false, value: 'value' });

      expect(deleteOwnConfigLeaf({ nested }, ['nested', 'leaf'])).toEqual({
        kind: 'unsafe',
        reason: 'Configuration leaf is not configurable.',
      });
      expect(nested.leaf).toBe('value');
    });

    it.each([
      ['array', []],
      ['class instance', new (class ConfigValue {})()],
      ['date', new Date()],
    ])('rejects a %s intermediate', (_label, nested) => {
      expect(deleteOwnConfigLeaf({ nested }, ['nested', 'leaf'])).toEqual({
        kind: 'unsafe',
        reason: 'Configuration path crosses a non-plain object.',
      });
    });

    it('rejects prototype objects', () => {
      class ConfigValue {}

      expect(deleteOwnConfigLeaf({ nested: ConfigValue.prototype }, ['nested', 'leaf'])).toEqual({
        kind: 'unsafe',
        reason: 'Configuration path crosses a non-plain object.',
      });
    });

    it('rejects deleting an unknown object-valued section', () => {
      const root = { custom: { section: { leaf: true } } };

      expect(deleteOwnConfigLeaf(root, ['custom', 'section'], { rejectObjectLeaf: true })).toEqual({
        kind: 'section',
      });
      expect(root.custom.section).toEqual({ leaf: true });
    });

    it('returns missing idempotently for absent own properties', () => {
      expect(deleteOwnConfigLeaf({ custom: {} }, ['custom', 'leaf'])).toEqual({ kind: 'missing' });
    });
  });
});
