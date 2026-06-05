export type IntegrationSecretKind = 'access_token' | 'refresh_token';
export type IntegrationSecretProvider = 'github';

export interface IntegrationSecretContext {
  readonly secretClass: string;
  readonly ownerId: string;
}

export function integrationSecretContext(
  secret: IntegrationSecretKind,
  userId: string,
  provider: IntegrationSecretProvider,
): IntegrationSecretContext {
  return { secretClass: `integration_${secret}`, ownerId: `${provider}:${userId}` };
}
