import { json, type RequestHandler } from 'express';
import { securityHeaders } from '../auth/embedded-as/securityHeaders.js';

/** Run before generic JSON parsing; never expose parser messages or request bodies. */
export function invitationAdminBodyBoundary(): RequestHandler[] {
  const parse = json({ limit: '2kb', inflate: false, strict: true, type: 'application/json' });
  return [securityHeaders(), (req, res, next) => {
    if (req.method !== 'POST') { next(); return; }
    if (!req.is('application/json')) { res.status(415).json({ error: 'Invitation request unavailable' }); return; }
    parse(req, res, error => {
      if (!error) { next(); return; }
      const status = error.status === 413 || error.status === 415 ? error.status : 400;
      res.status(status).json({ error: 'Invitation request unavailable' });
    });
  }];
}
