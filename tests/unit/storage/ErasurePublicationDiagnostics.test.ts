import { expect, it } from '@jest/globals';
import { ErasurePublicationDiagnostics } from './fixtures/erasurePublicationDiagnostics.js';

it('keeps a fixed aggregate across repeated actions and incomplete publication paths', () => {
  let now = 100;
  const diagnostics = new ErasurePublicationDiagnostics(() => now);
  diagnostics.publication('ready-durable'); // No operation has been admitted yet.
  expect(diagnostics.summary().labels).toEqual({});
  diagnostics.start();
  now = 110; diagnostics.publication('head-prepared-durable');
  now = 120; diagnostics.publication('ready-durable');
  now = 150; diagnostics.publication('segment-durable');
  now = 160; diagnostics.publication('inventory-durable');
  for (let index = 0; index < 10000; index++) {
    now++; diagnostics.publication('action-prepared-durable');
    now++; diagnostics.publication('after-owner-action');
  }
  const partial = diagnostics.summary();
  expect(Object.keys(partial.labels)).toHaveLength(6);
  expect(partial.labels['after-owner-action']).toEqual({ count: 10000, firstMs: 62, lastMs: 20060 });
  expect(partial.groups.actions.count).toBe(20000);
  expect(partial.boundarySpans.inventoryToOwnerRootRemovedMs).toBeUndefined();
  expect(partial.afterErasureWorkMs).toBeUndefined();
  now = 20200; diagnostics.publication('owner-root-removed-durable');
  now = 20300; diagnostics.publication('evidence-retiring-durable');
  now = 20400; diagnostics.publication('before-return');
  now = 20500; diagnostics.afterWork();
  const summary = diagnostics.summary();
  expect(summary.boundarySpans).toEqual({ operationStartToReadyMs: 20, readyToInventoryMs: 40,
    inventoryToOwnerRootRemovedMs: 20040, ownerRootRemovedToWorkReportMs: 300 });
  expect(summary.groups.retirement).toEqual({ count: 2, firstMs: 20200, lastMs: 20300 });
  expect(summary.afterErasureWorkMs).toBe(20400);
  summary.labels['ready-durable']!.count = 999;
  expect(diagnostics.summary().labels['ready-durable']!.count).toBe(1);
});
