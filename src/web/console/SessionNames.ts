/**
 * Friendly session names drawn from famous puppets, marionettes,
 * and puppet characters throughout history.
 *
 * Names are assigned from a pool and returned after a cooldown period
 * when sessions end. This keeps the active session list human-readable
 * and on-brand for DollhouseMCP.
 *
 * @since v2.1.0 — Issue #1700
 */

import { logger } from '../../utils/logger.js';

/**
 * Famous puppets, marionettes, and puppet characters from around the world.
 */
const PUPPET_NAMES: readonly string[] = [
  // Classic & traditional
  'Punch',
  'Judy',
  'Pinocchio',
  'Petrouchka',
  'Pulcinella',
  'Guignol',
  'Kasperle',

  // Muppets & Jim Henson
  'Kermit',
  'Piggy',
  'Fozzie',
  'Gonzo',
  'Scooter',
  'Rowlf',
  'Waldorf',
  'Statler',

  // Kukla, Fran and Ollie
  'Kukla',
  'Ollie',

  // Howdy Doody era
  'Howdy',
  'Clarabell',

  // Sesame Street
  'Grover',
  'Elmo',
  'Ernie',
  'Bert',
  'Oscar',

  // Ventriloquist & variety
  'Mortimer',
  'Lambchop',
  'Madame',
  'Topo',

  // International puppetry
  'Bunraku',
  'Wayang',
  'Petrushka',
  'Hanneschen',
  'Vitezslav',

  // Modern & pop culture
  'Salem',
  'Triumph',
  'Peanut',
  'Achmed',

  // Marionette traditions
  'Fantoccini',
  'Saltimbanque',
  'Burattino',
  'Harlequin',

  // Dollhouse (TV series)
  'Echo',

  // Inside jokes
  'Spike',
  'Angel',
];

/** Cooldown period before a released name can be reused (ms) */
const NAME_COOLDOWN_MS = 5 * 60_000; // 5 minutes

interface CooldownEntry {
  name: string;
  releasedAt: number;
}

/**
 * Manages friendly session name assignment from the puppet name pool.
 */
export class SessionNamePool {
  /** Names currently assigned to active sessions: sessionId → name */
  private assigned = new Map<string, string>();
  /** Reverse lookup: name → sessionId */
  private nameToSession = new Map<string, string>();
  /** Names in cooldown after session end */
  private cooldown: CooldownEntry[] = [];

  /**
   * Assign a friendly name to a session.
   * Returns an existing assignment if the session already has one.
   */
  assign(sessionId: string): string {
    // Already assigned?
    const existing = this.assigned.get(sessionId);
    if (existing) return existing;

    // Flush expired cooldowns
    this.flushCooldowns();

    // Find an available name
    const cooldownNames = new Set(this.cooldown.map(c => c.name));
    const availableName = PUPPET_NAMES.find(
      name => !this.nameToSession.has(name) && !cooldownNames.has(name)
    );

    if (availableName) {
      this.assigned.set(sessionId, availableName);
      this.nameToSession.set(availableName, sessionId);
      logger.debug(`[SessionNames] Assigned '${availableName}' to ${sessionId}`);
      return availableName;
    }

    // All names in use or cooling down — try cooldown names (oldest first)
    if (this.cooldown.length > 0) {
      const oldest = this.cooldown.shift()!;
      this.assigned.set(sessionId, oldest.name);
      this.nameToSession.set(oldest.name, sessionId);
      logger.debug(`[SessionNames] Assigned '${oldest.name}' to ${sessionId} (early cooldown release)`);
      return oldest.name;
    }

    // Truly exhausted — fall back to truncated session ID
    const fallback = sessionId.split('-')[1] || sessionId.slice(0, 8);
    this.assigned.set(sessionId, fallback);
    logger.warn(`[SessionNames] Name pool exhausted, using fallback '${fallback}' for ${sessionId}`);
    return fallback;
  }

  /**
   * Release a name back to the pool with a cooldown period.
   */
  release(sessionId: string): void {
    const name = this.assigned.get(sessionId);
    if (!name) return;

    this.assigned.delete(sessionId);
    this.nameToSession.delete(name);

    // Only cooldown puppet names, not fallback IDs
    if (PUPPET_NAMES.includes(name)) {
      this.cooldown.push({ name, releasedAt: Date.now() });
    }

    logger.debug(`[SessionNames] Released '${name}' from ${sessionId} (cooldown ${NAME_COOLDOWN_MS / 1000}s)`);
  }

  /**
   * Get the friendly name for a session, or undefined if not assigned.
   */
  getName(sessionId: string): string | undefined {
    return this.assigned.get(sessionId);
  }

  /**
   * Get all current assignments.
   */
  getAll(): Map<string, string> {
    return new Map(this.assigned);
  }

  private flushCooldowns(): void {
    const now = Date.now();
    this.cooldown = this.cooldown.filter(c => (now - c.releasedAt) < NAME_COOLDOWN_MS);
  }
}
