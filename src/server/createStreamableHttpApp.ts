import express, { type Express, type Router } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { hostHeaderValidation, localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { logger } from '../utils/logger.js';
import { invitationAdminBodyBoundary } from './invitationAdminBodyBoundary.js';

/** Internal mount seam only; bootstrap must validate the complete deployment first. */
export interface OnboardingHttpRouters {
  readonly claimPageRouter: Router;
  readonly apiRouter: Router;
}

/** Preserve the SDK default app; opt-in routes must own their bodies before JSON parsing. */
export function createStreamableHttpApp(options: {
  readonly host: string;
  readonly allowedHosts?: string[];
  readonly onboarding?: OnboardingHttpRouters;
}): Express {
  if (!options.onboarding) return createMcpExpressApp(options);
  const app = express();
  // SDK 1.27 host-selection parity, using its exported validators directly.
  // Its app factory installs express.json() first, so it cannot host these routes.
  if (options.allowedHosts) app.use(hostHeaderValidation(options.allowedHosts));
  else if (['127.0.0.1', 'localhost', '::1'].includes(options.host)) app.use(localhostHostValidation());
  else if (options.host === '0.0.0.0' || options.host === '::') {
    logger.warn('Server is binding to all interfaces without DNS rebinding protection; configure allowedHosts or authentication.');
  }
  app.get('/auth/onboarding/invitation', options.onboarding.claimPageRouter);
  app.use('/auth/onboarding', options.onboarding.apiRouter);
  app.use('/api/v1/admin/accounts/invitations', ...invitationAdminBodyBoundary());
  app.use(express.json());
  return app;
}
