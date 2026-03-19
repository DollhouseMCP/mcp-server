// Root Jest config: routes tests to the correct project config automatically.
// This allows `npx jest <path>` to work without --experimental-vm-modules
// by matching unit vs integration tests to their respective configs.
//
// Note: `npm test` and `npm run test:integration` use explicit --config flags,
// so they bypass this file entirely.
module.exports = {
  projects: [
    '<rootDir>/tests/jest.config.cjs',
    '<rootDir>/tests/jest.integration.config.cjs',
  ],
};
