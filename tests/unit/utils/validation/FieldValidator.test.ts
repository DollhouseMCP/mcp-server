/**
 * Unit tests for FieldValidator
 *
 * Tests all validation rules: required, type, enum, array, semver, length, pattern, range
 */

import { describe, it, expect } from '@jest/globals';
import { FieldValidator } from '../../../../src/utils/validation/FieldValidator.js';

describe('FieldValidator', () => {
  describe('required()', () => {
    it('should return null for non-empty string', () => {
      const result = FieldValidator.required('test', 'name');
      expect(result).toBeNull();
    });

    it('should return error for undefined', () => {
      const result = FieldValidator.required(undefined, 'name');
      expect(result).toEqual({
        field: 'name',
        message: 'name is required'
      });
    });

    it('should return error for null', () => {
      const result = FieldValidator.required(null, 'name');
      expect(result).toEqual({
        field: 'name',
        message: 'name is required'
      });
    });

    it('should return error for empty string', () => {
      const result = FieldValidator.required('', 'name');
      expect(result).toEqual({
        field: 'name',
        message: 'name is required and cannot be empty'
      });
    });

    it('should return error for whitespace-only string', () => {
      const result = FieldValidator.required('   ', 'name');
      expect(result).toEqual({
        field: 'name',
        message: 'name is required and cannot be empty'
      });
    });

    it('should return null for non-string values (numbers)', () => {
      const result = FieldValidator.required(42, 'count');
      expect(result).toBeNull();
    });

    it('should return null for non-string values (booleans)', () => {
      const result = FieldValidator.required(false, 'enabled');
      expect(result).toBeNull();
    });
  });

  describe('type()', () => {
    it('should return null for correct string type', () => {
      const result = FieldValidator.type('test', 'string', 'name');
      expect(result).toBeNull();
    });

    it('should return null for correct number type', () => {
      const result = FieldValidator.type(42, 'number', 'count');
      expect(result).toBeNull();
    });

    it('should return null for correct boolean type', () => {
      const result = FieldValidator.type(true, 'boolean', 'enabled');
      expect(result).toBeNull();
    });

    it('should return null for correct object type', () => {
      const result = FieldValidator.type({}, 'object', 'config');
      expect(result).toBeNull();
    });

    it('should return null for correct array type', () => {
      const result = FieldValidator.type([], 'array', 'items');
      expect(result).toBeNull();
    });

    it('should return error for wrong type (string vs number)', () => {
      const result = FieldValidator.type('42', 'number', 'count');
      expect(result).toEqual({
        field: 'count',
        message: 'count must be of type number, got string'
      });
    });

    it('should return error for non-array when array expected', () => {
      const result = FieldValidator.type('not-array', 'array', 'items');
      expect(result).toEqual({
        field: 'items',
        message: 'items must be an array'
      });
    });

    it('should return null for undefined/null (use required validator)', () => {
      expect(FieldValidator.type(undefined, 'string', 'name')).toBeNull();
      expect(FieldValidator.type(null, 'string', 'name')).toBeNull();
    });
  });

  describe('enum()', () => {
    it('should return null for valid enum value', () => {
      const result = FieldValidator.enum('option1', ['option1', 'option2'], 'choice');
      expect(result).toBeNull();
    });

    it('should return error for invalid enum value', () => {
      const result = FieldValidator.enum('invalid', ['option1', 'option2'], 'choice');
      expect(result).toEqual({
        field: 'choice',
        message: 'choice must be one of: option1, option2. Got: invalid'
      });
    });

    it('should return null for undefined/null (use required validator)', () => {
      expect(FieldValidator.enum(undefined, ['opt1'], 'choice')).toBeNull();
      expect(FieldValidator.enum(null, ['opt1'], 'choice')).toBeNull();
    });

    it('should handle empty allowed list', () => {
      const result = FieldValidator.enum('anything', [], 'choice');
      expect(result).toEqual({
        field: 'choice',
        message: 'choice must be one of: . Got: anything'
      });
    });
  });

  describe('array()', () => {
    it('should return null for valid array', () => {
      const result = FieldValidator.array([1, 2, 3], 'items');
      expect(result).toBeNull();
    });

    it('should return null for empty array when no minLength', () => {
      const result = FieldValidator.array([], 'items');
      expect(result).toBeNull();
    });

    it('should return null for array meeting minLength', () => {
      const result = FieldValidator.array([1, 2], 'items', 2);
      expect(result).toBeNull();
    });

    it('should return error for non-array', () => {
      const result = FieldValidator.array('not-array', 'items');
      expect(result).toEqual({
        field: 'items',
        message: 'items must be an array'
      });
    });

    it('should return error for array below minLength', () => {
      const result = FieldValidator.array([1], 'items', 2);
      expect(result).toEqual({
        field: 'items',
        message: 'items must have at least 2 items'
      });
    });

    it('should return error for empty array with minLength 1', () => {
      const result = FieldValidator.array([], 'items', 1);
      expect(result).toEqual({
        field: 'items',
        message: 'items must have at least 1 item'
      });
    });

    it('should return null for undefined/null (use required validator)', () => {
      expect(FieldValidator.array(undefined, 'items')).toBeNull();
      expect(FieldValidator.array(null, 'items')).toBeNull();
    });
  });

  describe('semverVersion()', () => {
    it('should return null for valid semver', () => {
      expect(FieldValidator.semverVersion('1.0.0', 'version')).toBeNull();
      expect(FieldValidator.semverVersion('2.1.3', 'version')).toBeNull();
      expect(FieldValidator.semverVersion('0.0.1', 'version')).toBeNull();
    });

    it('should return null for semver with pre-release', () => {
      expect(FieldValidator.semverVersion('1.0.0-alpha', 'version')).toBeNull();
      expect(FieldValidator.semverVersion('1.0.0-beta.1', 'version')).toBeNull();
    });

    it('should return null for semver with build metadata', () => {
      expect(FieldValidator.semverVersion('1.0.0+build.1', 'version')).toBeNull();
    });

    it('should return error for invalid semver format', () => {
      const result = FieldValidator.semverVersion('1.0', 'version');
      expect(result).toEqual({
        field: 'version',
        message: 'version must be a valid semantic version (e.g., 1.0.0)'
      });
    });

    it('should return error for non-numeric version', () => {
      const result = FieldValidator.semverVersion('abc', 'version');
      expect(result).toEqual({
        field: 'version',
        message: 'version must be a valid semantic version (e.g., 1.0.0)'
      });
    });

    it('should return error for non-string value', () => {
      const result = FieldValidator.semverVersion(123, 'version');
      expect(result).toEqual({
        field: 'version',
        message: 'version must be a string'
      });
    });

    it('should return null for undefined/null (use required validator)', () => {
      expect(FieldValidator.semverVersion(undefined, 'version')).toBeNull();
      expect(FieldValidator.semverVersion(null, 'version')).toBeNull();
    });
  });

  describe('length()', () => {
    it('should return null for string within bounds', () => {
      const result = FieldValidator.length('test', 'name', 1, 10);
      expect(result).toBeNull();
    });

    it('should return null for string at minimum length', () => {
      const result = FieldValidator.length('a', 'name', 1, 10);
      expect(result).toBeNull();
    });

    it('should return null for string at maximum length', () => {
      const result = FieldValidator.length('0123456789', 'name', 1, 10);
      expect(result).toBeNull();
    });

    it('should return error for string too short', () => {
      const result = FieldValidator.length('', 'name', 1, 10);
      expect(result).toEqual({
        field: 'name',
        message: 'name must be at least 1 character long'
      });
    });

    it('should return error for string too long', () => {
      const result = FieldValidator.length('12345678901', 'name', 1, 10);
      expect(result).toEqual({
        field: 'name',
        message: 'name must be at most 10 characters long'
      });
    });

    it('should handle plural forms correctly', () => {
      const result1 = FieldValidator.length('', 'name', 2, 10);
      expect(result1?.message).toBe('name must be at least 2 characters long');

      const result2 = FieldValidator.length('123', 'name', 1, 2);
      expect(result2?.message).toBe('name must be at most 2 characters long');
    });

    it('should return error for non-string value', () => {
      const result = FieldValidator.length(123, 'name', 1, 10);
      expect(result).toEqual({
        field: 'name',
        message: 'name must be a string'
      });
    });

    it('should return null for undefined/null (use required validator)', () => {
      expect(FieldValidator.length(undefined, 'name', 1, 10)).toBeNull();
      expect(FieldValidator.length(null, 'name', 1, 10)).toBeNull();
    });
  });

  describe('pattern()', () => {
    it('should return null for matching pattern', () => {
      const result = FieldValidator.pattern('test123', /^[a-z0-9]+$/, 'username');
      expect(result).toBeNull();
    });

    it('should return error for non-matching pattern', () => {
      const result = FieldValidator.pattern('Test@123', /^[a-z0-9]+$/, 'username');
      expect(result).toEqual({
        field: 'username',
        message: 'username must match the required pattern'
      });
    });

    it('should include pattern description in error message', () => {
      const result = FieldValidator.pattern(
        'invalid',
        /^[A-Z]+$/,
        'code',
        'uppercase letters only'
      );
      expect(result).toEqual({
        field: 'code',
        message: 'code must match the required pattern (uppercase letters only)'
      });
    });

    it('should return error for non-string value', () => {
      const result = FieldValidator.pattern(123, /^\d+$/, 'code');
      expect(result).toEqual({
        field: 'code',
        message: 'code must be a string'
      });
    });

    it('should return null for undefined/null (use required validator)', () => {
      expect(FieldValidator.pattern(undefined, /test/, 'field')).toBeNull();
      expect(FieldValidator.pattern(null, /test/, 'field')).toBeNull();
    });
  });

  describe('range()', () => {
    it('should return null for number within range', () => {
      const result = FieldValidator.range(50, 'score', 0, 100);
      expect(result).toBeNull();
    });

    it('should return null for number at minimum', () => {
      const result = FieldValidator.range(0, 'score', 0, 100);
      expect(result).toBeNull();
    });

    it('should return null for number at maximum', () => {
      const result = FieldValidator.range(100, 'score', 0, 100);
      expect(result).toBeNull();
    });

    it('should return error for number below minimum', () => {
      const result = FieldValidator.range(-1, 'score', 0, 100);
      expect(result).toEqual({
        field: 'score',
        message: 'score must be between 0 and 100'
      });
    });

    it('should return error for number above maximum', () => {
      const result = FieldValidator.range(101, 'score', 0, 100);
      expect(result).toEqual({
        field: 'score',
        message: 'score must be between 0 and 100'
      });
    });

    it('should return error for non-number value', () => {
      const result = FieldValidator.range('50', 'score', 0, 100);
      expect(result).toEqual({
        field: 'score',
        message: 'score must be a number'
      });
    });

    it('should return null for undefined/null (use required validator)', () => {
      expect(FieldValidator.range(undefined, 'score', 0, 100)).toBeNull();
      expect(FieldValidator.range(null, 'score', 0, 100)).toBeNull();
    });
  });

  describe('integration tests', () => {
    it('should combine multiple validators for comprehensive validation', () => {
      const name = 'Test Name';

      // All should pass
      expect(FieldValidator.required(name, 'name')).toBeNull();
      expect(FieldValidator.type(name, 'string', 'name')).toBeNull();
      expect(FieldValidator.length(name, 'name', 1, 100)).toBeNull();
    });

    it('should validate complex field with multiple rules', () => {
      const version = '1.2.3';

      // All should pass
      expect(FieldValidator.required(version, 'version')).toBeNull();
      expect(FieldValidator.type(version, 'string', 'version')).toBeNull();
      expect(FieldValidator.semverVersion(version, 'version')).toBeNull();
    });

    it('should handle validation chains that fail early', () => {
      const emptyValue = '';

      // Should fail on required
      expect(FieldValidator.required(emptyValue, 'field')).not.toBeNull();

      // But type check would pass (it's a string, just empty)
      expect(FieldValidator.type(emptyValue, 'string', 'field')).toBeNull();
    });
  });
});
