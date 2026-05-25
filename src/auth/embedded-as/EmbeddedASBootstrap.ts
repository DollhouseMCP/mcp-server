import type { RequestHandler } from 'express';

import { logger } from '../../utils/logger.js';
import type { IAuthMethod } from './IAuthMethod.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

const MULTI_USER_METHODS: ReadonlySet<string> = new Set([
  'local-password',
  'magic-link',
  'github',
]);

const GATE_BYPASS_RULES: ReadonlyArray<{ path: string; mode: 'exact' | 'prefix' }> = [
  { path: '/.well-known/', mode: 'prefix' },
  { path: '/jwks', mode: 'exact' },
];

export class EmbeddedASBootstrap {
  constructor(
    private readonly methods: readonly IAuthMethod[],
    private readonly storage: IAuthStorageLayer,
    private readonly getReadyLatch: () => boolean,
    private readonly setReadyLatch: (ready: boolean) => void,
  ) {}

  isMultiUserMode(): boolean {
    return this.methods.some((m) => MULTI_USER_METHODS.has(m.id));
  }

  isHttpsPublicBaseUrl(publicBaseUrl: string): boolean {
    try {
      return new URL(publicBaseUrl).protocol === 'https:';
    } catch {
      return false;
    }
  }

  async isReadyForTraffic(): Promise<boolean> {
    if (!this.isMultiUserMode()) return true;
    if (this.getReadyLatch()) return true;
    try {
      const state = await this.storage.getBootstrapState();
      if (state.completed === true) {
        this.setReadyLatch(true);
        return true;
      }
      return false;
    } catch (err) {
      logger.warn('[EmbeddedAuthorizationServer] isReadyForTraffic storage read failed; reporting not-ready', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  bootstrapHint(): string {
    const ids = new Set(this.methods.map((m) => m.id));
    const lines: string[] = [];
    if (ids.has('local-password')) {
      lines.push(
        "Run 'dollhouse-create-user --username <name> --email <addr>' " +
        "to issue the first invite (this also marks bootstrap complete).",
      );
    }
    if (ids.has('magic-link')) {
      lines.push(
        "Run 'dollhouse-admin-bootstrap --method magic-link --email <admin@example.com>' " +
        "to claim the admin identity.",
      );
    }
    if (ids.has('github')) {
      lines.push(
        "Run 'dollhouse-admin-bootstrap --method github --github-username <gh-username>' " +
        "to claim the admin identity.",
      );
    }
    return lines.join(' OR ');
  }

  createBootstrapGate(): RequestHandler {
    if (!this.isMultiUserMode()) {
      return (_req, _res, next) => next();
    }

    return async (req, res, next) => {
      if (this.getReadyLatch()) {
        next();
        return;
      }
      if (EmbeddedASBootstrap.isGateBypass(req.path)) {
        next();
        return;
      }
      try {
        const state = await this.storage.getBootstrapState();
        if (state.completed) {
          this.setReadyLatch(true);
          next();
          return;
        }
        res.status(503).json({
          error: 'bootstrap_required',
          error_description:
            'This authorization server has not been bootstrapped. ' +
            'An operator must claim the first admin identity before any ' +
            'authentication flow is accepted.',
          next_step: this.bootstrapHint(),
        });
      } catch (err) {
        logger.error('[EmbeddedAuthorizationServer] bootstrap-gate storage read failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(503).json({
          error: 'bootstrap_check_unavailable',
          error_description: 'Unable to verify bootstrap state. Try again shortly.',
        });
      }
    };
  }

  private static isGateBypass(path: string): boolean {
    return GATE_BYPASS_RULES.some((rule) => {
      if (rule.mode === 'exact') {
        return path === rule.path;
      }
      return path === rule.path || path.startsWith(rule.path);
    });
  }
}
