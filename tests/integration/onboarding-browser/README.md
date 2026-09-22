# Onboarding browser qualification

The Chrome journey runs the built onboarding composition in two independent child processes against one temporary PostgreSQL database. An HTTPS test proxy presents a single browser origin and routes claim exchange and GitHub start to the second replica while the shell, context, and callback use the first.

A separate HTTPS probe runs in Chrome and Firefox, checking browser-generated Origin and absent Referer under the claim page privacy policy without request interception. CI installs Firefox using the lockfile-installed Playwright CLI.

Run the dedicated command:

```sh
npm run test:onboarding:browser
```

The provider and mail adapters are test-only fakes. The test proves browser behavior and store identity resolution; it does not contact GitHub, send mail, or exercise an ordinary GitHub login session.
