export type IntegrationSecretKind = 'access_token' | 'refresh_token';
export type IntegrationSecretProvider = string;

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

export function integrationDescriptorClientSecretContext(input: {
  readonly provider: string;
  readonly ownerUserId: string | null;
}): IntegrationSecretContext {
  return {
    secretClass: 'integration_oauth_client_secret',
    ownerId: `descriptor:${input.provider}:${input.ownerUserId ?? 'curated'}`,
  };
}
