import { closeDb } from '../harness/pg.js';

// Close the shared postgres pool after each spec file so jest exits cleanly.
afterAll(async () => {
  await closeDb();
});
