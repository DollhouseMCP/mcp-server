/**
 * Operation Documentation Coverage Gate (Issue #595)
 *
 * Cross-validates OPERATION_ROUTES (Router) against ALL_OPERATION_SCHEMAS (Schema)
 * to ensure every operation has both routing and documentation metadata.
 *
 * This test runs in CI via `npm test` and catches drift between the two registries.
 */

import { OPERATION_ROUTES } from '../../../../src/handlers/mcp-aql/OperationRouter.js';
import { ALL_OPERATION_SCHEMAS } from '../../../../src/handlers/mcp-aql/OperationSchema.js';

const routerOps = Object.keys(OPERATION_ROUTES).sort();
const schemaOps = Object.keys(ALL_OPERATION_SCHEMAS).sort();

describe('Operation Documentation Coverage (Issue #595)', () => {
  describe('Router ↔ Schema cross-reference', () => {
    it.each(routerOps)(
      'Operation "%s" in OPERATION_ROUTES has an ALL_OPERATION_SCHEMAS entry',
      (operation) => {
        expect(ALL_OPERATION_SCHEMAS).toHaveProperty(
          operation,
          expect.objectContaining({ endpoint: expect.any(String) })
        );
      }
    );

    it.each(schemaOps)(
      'Operation "%s" in ALL_OPERATION_SCHEMAS has an OPERATION_ROUTES entry',
      (operation) => {
        expect(OPERATION_ROUTES).toHaveProperty(
          operation,
          expect.objectContaining({ endpoint: expect.any(String) })
        );
      }
    );

    it.each(routerOps)(
      'Operation "%s" endpoint types match between Router and Schema',
      (operation) => {
        const routerEndpoint = OPERATION_ROUTES[operation]?.endpoint;
        const schemaEndpoint = ALL_OPERATION_SCHEMAS[operation]?.endpoint;
        expect(routerEndpoint).toBe(schemaEndpoint);
      }
    );

    it('should have identical operation counts in Router and Schema', () => {
      expect(routerOps.length).toBe(schemaOps.length);
    });

    it('should have identical operation sets in Router and Schema', () => {
      expect(routerOps).toEqual(schemaOps);
    });
  });

  describe('Schema quality — required fields', () => {
    it.each(schemaOps)(
      'Operation "%s" has non-empty description in Schema',
      (operation) => {
        const def = ALL_OPERATION_SCHEMAS[operation];
        expect(def.description).toBeTruthy();
        expect(def.description.length).toBeGreaterThan(0);
      }
    );

    it.each(schemaOps)(
      'Operation "%s" has returns defined (name + kind)',
      (operation) => {
        const def = ALL_OPERATION_SCHEMAS[operation];
        expect(def.returns).toBeDefined();
        expect(def.returns?.name).toBeTruthy();
        expect(def.returns?.kind).toMatch(/^(enum|object|scalar|union)$/);
      }
    );

    it.each(schemaOps)(
      'Operation "%s" has at least one example',
      (operation) => {
        const def = ALL_OPERATION_SCHEMAS[operation];
        expect(def.examples).toBeDefined();
        expect(def.examples!.length).toBeGreaterThan(0);
      }
    );
  });

  describe('Router quality — required fields', () => {
    it.each(routerOps)(
      'Operation "%s" has non-empty description in Router',
      (operation) => {
        const route = OPERATION_ROUTES[operation];
        expect(route.description).toBeTruthy();
        expect(route.description!.length).toBeGreaterThan(0);
      }
    );

    it.each(routerOps)(
      'Operation "%s" has descriptive Router description (length > 10, not just the operation name)',
      (operation) => {
        const route = OPERATION_ROUTES[operation];
        expect(route.description!.length).toBeGreaterThan(10);
        // Description should not just be the operation name
        expect(route.description!.toLowerCase()).not.toBe(operation.toLowerCase());
      }
    );
  });
});
