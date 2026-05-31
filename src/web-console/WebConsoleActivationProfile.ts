import { isLoopbackHost } from '../auth/oauth/url.js';
import type { AuthMethodId } from '../auth/embedded-as/AuthMethodFactory.js';
import { env } from '../config/env.js';
import type { WebConsoleActivationProfile } from './WebConsoleProductionActivation.js';

export const WEB_CONSOLE_SINGLE_USER_AUTH_METHODS: ReadonlySet<AuthMethodId> = new Set(['trivial-consent']);

export interface WebConsoleDeploymentSignal {
  readonly httpHost?: string;
  readonly authMethods?: readonly string[];
  readonly publicBaseUrl?: string;
  readonly sharedHosted?: boolean;
}

export interface WebConsoleActivationProfileResolutionOptions {
  readonly activationProfile?: WebConsoleActivationProfile;
  readonly deploymentSignal?: WebConsoleDeploymentSignal;
}

export function resolveWebConsoleActivationProfile(
  options: WebConsoleActivationProfileResolutionOptions = {},
): WebConsoleActivationProfile {
  if (isSharedHostedWebConsoleDeployment(options.deploymentSignal)) {
    return 'shared-hosted';
  }
  return options.activationProfile ?? 'development';
}

export function isSharedHostedWebConsoleDeployment(
  signal: WebConsoleDeploymentSignal = {},
): boolean {
  if (signal.sharedHosted === true) return true;

  const authMethods = signal.authMethods ?? env.DOLLHOUSE_AUTH_METHODS ?? [];
  if (!authMethods.some(isSharedHostedAuthMethod)) {
    return false;
  }

  const publicBaseUrl = signal.publicBaseUrl ?? env.DOLLHOUSE_PUBLIC_BASE_URL;
  if (isNonLoopbackPublicBaseUrl(publicBaseUrl)) return true;

  const httpHost = signal.httpHost ?? env.DOLLHOUSE_HTTP_HOST;
  return !isLoopbackHost(httpHost);
}

function isSharedHostedAuthMethod(method: string): boolean {
  return !WEB_CONSOLE_SINGLE_USER_AUTH_METHODS.has(method as AuthMethodId);
}

function isNonLoopbackPublicBaseUrl(publicBaseUrl: string | undefined): boolean {
  if (!publicBaseUrl) return false;
  try {
    const parsed = new URL(publicBaseUrl);
    return !isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}
