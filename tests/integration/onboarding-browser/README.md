# Onboarding browser qualification

This held qualification runs the built onboarding composition in two independent child processes against one temporary PostgreSQL database. An HTTPS test proxy presents a single browser origin and routes claim exchange and GitHub start to the second replica while the shell, context, and callback use the first.

Run `npm run build` first, then:

```sh
npx playwright test --config tests/integration/onboarding-browser/playwright.config.ts
```

The provider and mail adapters are test-only fakes. The test proves browser behavior and store identity resolution; it does not contact GitHub, send mail, or exercise an ordinary GitHub login session.
