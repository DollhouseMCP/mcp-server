export type PublicHealthStatus = 'ok' | 'not_ready';

export interface PublicHealthDto {
  readonly status: PublicHealthStatus;
  readonly checked_at: string;
}

export interface PublicReadinessDto extends PublicHealthDto {
  readonly ready: boolean;
}

export interface HealthReadinessSnapshot {
  readonly checkedAt: Date;
  readonly status: PublicHealthStatus;
  readonly ready: boolean;
}

export function toPublicHealthDto(checkedAt: Date): PublicHealthDto {
  return {
    status: 'ok',
    checked_at: checkedAt.toISOString(),
  };
}

export function toPublicReadinessDto(snapshot: HealthReadinessSnapshot): PublicReadinessDto {
  return {
    status: snapshot.status,
    ready: snapshot.ready,
    checked_at: snapshot.checkedAt.toISOString(),
  };
}
