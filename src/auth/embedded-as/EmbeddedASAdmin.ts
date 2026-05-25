import type { RequestHandler } from 'express';

import type { IAuthProvider } from '../IAuthProvider.js';
import { assertHasRole } from '../assertHasRole.js';
import { createUnifiedAuthMiddleware } from '../authMiddleware.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

export class EmbeddedASAdmin {
  constructor(
    private readonly provider: IAuthProvider,
    private readonly storage: IAuthStorageLayer,
    private readonly getProtectedResourceMetadataUrl: () => string,
  ) {}

  createAdminMeHandler(): RequestHandler[] {
    const validateBearer = createUnifiedAuthMiddleware({
      provider: this.provider,
      protectedResourceMetadataUrl: this.getProtectedResourceMetadataUrl(),
    });
    const adminGuard = assertHasRole('admin');
    const handler: RequestHandler = (req, res, next) => {
      void (async () => {
        try {
          const claims = res.locals.authClaims;
          if (!claims) {
            next(new Error('admin/me handler reached without authClaims'));
            return;
          }
          const bootstrap = await this.storage.getBootstrapState();
          const account = await this.storage.getAccount(claims.sub);

          if (!account) {
            res.status(410).json({
              error: 'admin account no longer exists',
              sub: claims.sub,
            });
            return;
          }

          const callerIsBootstrapAdmin = bootstrap.adminSub === claims.sub;
          res.json({
            sub: claims.sub,
            roles: claims.roles ?? [],
            email: account.email,
            displayName: account.displayName,
            bootstrap: {
              adminMethod: bootstrap.adminMethod,
              completedAt: bootstrap.completedAt,
              ...(callerIsBootstrapAdmin ? { adminSub: bootstrap.adminSub } : {}),
            },
          });
        } catch (err) {
          next(err);
        }
      })();
    };

    return [validateBearer, adminGuard, handler];
  }
}
