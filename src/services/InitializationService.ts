import { PersonaManager } from '../persona/PersonaManager.js';

/**
 * Coordinates one-time initialization routines that were previously
 * embedded inside HandlerContext. Ensures initialization logic runs once
 * while remaining safe under concurrent access.
 */
export class InitializationService {
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(private readonly personaManager: PersonaManager) {}

  async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        try {
          await this.personaManager.initialize();
          this.initialized = true;
        } finally {
          this.initializationPromise = null;
        }
      })();
    }

    try {
      await this.initializationPromise;
    } catch (error) {
      this.initialized = false;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.initialized = false;
    this.initializationPromise = null;
  }
}
