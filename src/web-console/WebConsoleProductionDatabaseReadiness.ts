export interface WebConsoleProductionDatabaseReadinessSnapshot {
  readonly ready: boolean;
  readonly failureCodes: readonly string[];
  readonly detail?: string;
}

export interface IProductionDatabaseReadiness {
  getReadiness(): Promise<WebConsoleProductionDatabaseReadinessSnapshot>;
}

export class StaticProductionDatabaseReadiness implements IProductionDatabaseReadiness {
  constructor(private readonly snapshot: WebConsoleProductionDatabaseReadinessSnapshot) {}

  getReadiness(): Promise<WebConsoleProductionDatabaseReadinessSnapshot> {
    return Promise.resolve(this.snapshot);
  }
}

export function productionDatabaseReady(): IProductionDatabaseReadiness {
  return new StaticProductionDatabaseReadiness({
    ready: true,
    failureCodes: [],
  });
}

export function productionDatabaseNotVerified(detail = 'Production database and migration state have not been verified.'): IProductionDatabaseReadiness {
  return new StaticProductionDatabaseReadiness({
    ready: false,
    failureCodes: ['production_database_not_verified'],
    detail,
  });
}
