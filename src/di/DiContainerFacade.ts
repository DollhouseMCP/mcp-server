/**
 * DiContainerFacade — the minimal container surface a registrar needs.
 *
 * Registrars extract DI wiring out of `Container.ts` (which is becoming
 * a god object — see the pre-Phase-5 cleanup plan). Each registrar
 * takes a `DiContainerFacade` rather than the concrete `DollhouseContainer`
 * class for two reasons:
 *
 *   1. Prevents circular imports: `Container.ts` imports registrars, so
 *      registrars cannot import `Container.ts` back. The facade typed
 *      interface breaks the cycle.
 *   2. Narrows the registrar's blast radius: registrars only need these
 *      three methods, so anything the full container exposes that they
 *      don't touch stays out of their reach.
 *
 * Every registrar that wires services into the DI container should
 * import this type rather than defining its own copy.
 *
 * @module di/DiContainerFacade
 * @since Step 4.5
 */

export interface DiContainerFacade {
  register<T>(name: string, factory: () => T): void;
  resolve<T>(name: string): T;
  hasRegistration(name: string): boolean;
}
