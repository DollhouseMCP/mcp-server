import { afterAll, beforeAll, expect, it, jest } from '@jest/globals';
import { readdirSync } from 'node:fs';
import type { ElementManagerLookup } from '../../../src/elements/ElementManagerLookup.js';
import { DefaultElementProvider } from '../../../src/portfolio/DefaultElementProvider.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { createIntegrationContainer, type IntegrationContainer } from '../../helpers/integration-container.js';

const bundled = Object.values(ElementType).flatMap(type =>
  readdirSync(new URL(`../../../data/${type}/`, import.meta.url))
    .filter(filename => /\.(md|ya?ml)$/u.test(filename))
    .map(filename => [`${type}/${filename}`, type, filename] as const)
);

let fixture: IntegrationContainer;
let managers: ElementManagerLookup;

beforeAll(async () => {
  fixture = await createIntegrationContainer();
  const environment = jest.replaceProperty(process, 'env', { ...process.env, DOLLHOUSE_LOAD_TEST_DATA: 'true' });
  try {
    await new DefaultElementProvider().populateDefaults(fixture.portfolioDir);
  } finally {
    environment.restore();
  }
  managers = fixture.container.resolve<ElementManagerLookup>('ElementManagerLookup');
});

afterAll(async () => {
  await fixture?.dispose();
});

it.each(bundled)('loads bundled starter %s', async (_label, type, filename) => {
  const element = await managers.managerFor(type).load(filename);
  expect(element.metadata.name).toEqual(expect.any(String));
});
