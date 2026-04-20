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

import { createHash, randomInt } from 'node:crypto';
import { logger } from '../../utils/logger.js';

/**
 * Famous puppets, marionettes, and puppet characters from around the world.
 * Order doesn't matter — the pool is shuffled on startup.
 */
export const ALL_PUPPET_NAMES: readonly string[] = [
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

  // Classic dolls
  'Barbie',
  'Ken',
  'Skipper',
  'Midge',
  'Christie',
  'Annie',
  'Andy',
  'Cathy',
  'Teddy',
  'Xavier',
  'Strawberry',
  'Blythe',
  'Ginny',
  'Betsy',
  'Madeline',
];

/** Names that can never be assigned to a leader session */
const FOLLOWER_ONLY_NAMES = new Set(['Punch']);

/** Fisher-Yates shuffle using crypto.randomInt (unbiased, no modulo) */
function shuffleArray<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Shuffled copy of the name pool — randomized on each process start */
const PUPPET_NAMES: string[] = shuffleArray([...ALL_PUPPET_NAMES]);

function getAssignablePuppetNames(isLeader = false): readonly string[] {
  return isLeader
    ? ALL_PUPPET_NAMES.filter(name => !FOLLOWER_ONLY_NAMES.has(name))
    : ALL_PUPPET_NAMES;
}

/**
 * Iconic attire and accessories drawn from famous dolls, puppets, and
 * theatrical characters throughout history. Used to name console tokens
 * so they never collide with the session puppet-name pool (#1871).
 *
 * Names evoke costume pieces — a token is something you wear or carry,
 * not a person.
 */
export const ALL_TOKEN_NAMES: readonly string[] = [
  // Victorian & theatrical
  'Top Hat',
  'Monocle',
  'Trench Coat',
  'Opera Cape',
  'Opera Gloves',
  'Velvet Cloak',
  'Lace Collar',
  'Silk Cravat',
  'Waistcoat',
  'Gilt Button',

  // Phantom, masks, mystery
  'Half Mask',
  'Domino Mask',
  'Feathered Mask',

  // Punch & Judy / Harlequin
  'Jester Bells',
  'Diamond Suit',
  'Bell Cap',
  'Slapstick',
  'Red Nose',

  // Puppet traditions
  'Marionette Strings',
  'Cracked Porcelain',
  'Papier-Mâché',

  // Classic dolls & characters
  'Pink Corvette',
  'Red Yarn Hair',
  'Sailor Suit',
  'Yellow Hat',
  'Ruby Slippers',
  'Glass Slipper',
  'Blue Ribbon',
  'Striped Stockings',

  // Wizard / witch / fantasy
  'Pointed Hat',
  'Broomstick',
  'Silver Wand',
  'Tin Crown',
  'Straw Hat',

  // Adventure & mystery
  'Deerstalker',
  'Magnifying Glass',
  'Feathered Cap',
  'Silver Buckle',
  'Wicker Basket',
];

/**
 * Pick a random token name from the attire pool.
 * Used by the console token module to name newly created tokens (#1871).
 * Drawn from a separate pool to avoid collision with session puppet names.
 */
export function pickRandomTokenName(): string {
  return ALL_TOKEN_NAMES[randomInt(ALL_TOKEN_NAMES.length)];
}

/**
 * Derive a stable preferred puppet name for a runtime session.
 *
 * This lets followers and leaders agree on a canonical human-facing name for
 * the same runtime session before the leader decides whether it can reserve
 * that name in the active pool.
 */
export function derivePreferredSessionName(sessionId: string, isLeader = false): string {
  const candidates = getAssignablePuppetNames(isLeader);
  const digest = createHash('sha256').update(sessionId, 'utf8').digest();
  const index = digest.readUInt32BE(0) % candidates.length;
  return candidates[index];
}

/**
 * Canonical colors for each puppet character.
 * Adjusted from true canonical colors for UI readability in both light/dark themes.
 */
const PUPPET_COLORS: Record<string, string> = {
  'Punch':        '#DC143C', // crimson red costume
  'Judy':         '#1E90FF', // blue dress
  'Pinocchio':    '#DAA520', // goldenrod (wooden, yellow hat)
  'Petrouchka':   '#B0BEC5', // blue-gray (white costume, adjusted for visibility)
  'Pulcinella':   '#90A4AE', // gray-blue (white costume, adjusted)
  'Guignol':      '#8B4513', // saddle brown
  'Kasperle':     '#FF0000', // red pointed cap
  'Kermit':       '#4CAF50', // green frog
  'Piggy':        '#E91E8C', // hot pink (glamorous pig)
  'Fozzie':       '#CC7722', // ochre brown bear
  'Gonzo':        '#4169E1', // royal blue
  'Scooter':      '#FF8C00', // dark orange
  'Rowlf':        '#8B6914', // dark goldenrod brown dog
  'Waldorf':      '#556B2F', // dark olive green
  'Statler':      '#708090', // slate gray
  'Kukla':        '#FF0000', // red nose and costume
  'Ollie':        '#228B22', // forest green dragon
  'Howdy':        '#E2725B', // terra cotta
  'Clarabell':    '#FFCC00', // bright yellow clown
  'Grover':       '#4682B4', // steel blue
  'Elmo':         '#FF2400', // scarlet red
  'Ernie':        '#F4A460', // sandy brown
  'Bert':         '#FFD700', // gold yellow
  'Oscar':        '#6B8E23', // olive drab green
  'Mortimer':     '#DEB887', // burlywood
  'Lambchop':     '#D4C5A9', // warm cream (adjusted from pure white)
  'Madame':       '#800080', // purple
  'Topo':         '#A0A0A0', // silver gray
  'Bunraku':      '#B22222', // firebrick red
  'Wayang':       '#6B4226', // dark leather brown (lightened for visibility)
  'Petrushka':    '#FF4500', // orange red
  'Hanneschen':   '#CD5C5C', // indian red
  'Vitezslav':    '#B8860B', // dark goldenrod
  'Salem':        '#4A4A4A', // dark gray (black cat, lightened for visibility)
  'Triumph':      '#6F4E37', // coffee brown
  'Peanut':       '#9370DB', // medium purple
  'Achmed':       '#C8BFA9', // bone/parchment (lightened from beige)
  'Fantoccini':   '#C41E3A', // cardinal red
  'Saltimbanque': '#DAA520', // goldenrod
  'Burattino':    '#D2691E', // chocolate brown
  'Harlequin':    '#E60026', // diamond red
  'Echo':         '#5C6370', // slate (dark attire, lightened for visibility)
  'Spike':        '#E8DCC8', // platinum/bleach (lightened for readability)
  'Angel':        '#3D3D3D', // charcoal (black duster, lightened for visibility)

  // Classic dolls
  'Barbie':       '#E91E90', // Barbie pink
  'Ken':          '#4A90D9', // Ken blue
  'Skipper':      '#FF6B6B', // coral red
  'Midge':        '#E87040', // warm auburn
  'Christie':     '#C06030', // warm brown
  'Annie':        '#E03030', // Raggedy Ann red yarn hair
  'Andy':         '#3070C0', // Raggedy Andy blue sailor outfit
  'Cathy':        '#D4A574', // Chatty Cathy vintage tan
  'Teddy':        '#A0784A', // Teddy Ruxpin bear brown
  'Xavier':       '#5AAF4A', // Xavier Roberts / Cabbage Patch green
  'Strawberry':   '#E8445A', // strawberry red-pink
  'Blythe':       '#7B68EE', // big-eyed purple
  'Ginny':        '#5B9BD5', // classic blue dress
  'Betsy':        '#DD7694', // rose pink
  'Madeline':     '#FFD700', // yellow hat
};

export function getPuppetColor(name: string): string | undefined {
  return PUPPET_COLORS[name] ?? undefined;
}

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
  private readonly assigned = new Map<string, string>();
  /** Reverse lookup: name → sessionId */
  private readonly nameToSession = new Map<string, string>();
  /** Names in cooldown after session end */
  private cooldown: CooldownEntry[] = [];

  /**
   * Assign a friendly name to a session.
   * Returns an existing assignment if the session already has one.
   *
   * @param isLeader - If true, follower-only names (e.g., Punch) are excluded
   */
  assign(sessionId: string, isLeader = false): string {
    // Already assigned?
    const existing = this.assigned.get(sessionId);
    if (existing) return existing;

    // Flush expired cooldowns
    this.flushCooldowns();

    // Find an available name, respecting leader restrictions
    const cooldownNames = new Set(this.cooldown.map(c => c.name));
    const availableName = PUPPET_NAMES.find(
      name => !this.nameToSession.has(name) &&
              !cooldownNames.has(name) &&
              !(isLeader && FOLLOWER_ONLY_NAMES.has(name))
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
   * Preserve an existing human-facing assignment during leadership handoff.
   * If the requested name is already taken by another live session, the pool
   * falls back to normal assignment logic rather than creating a duplicate.
   */
  adopt(sessionId: string, name: string, isLeader = false): string {
    const existing = this.assigned.get(sessionId);
    if (existing) return existing;

    this.flushCooldowns();

    if (
      ALL_PUPPET_NAMES.includes(name) &&
      !this.nameToSession.has(name) &&
      !(isLeader && FOLLOWER_ONLY_NAMES.has(name))
    ) {
      this.assigned.set(sessionId, name);
      this.nameToSession.set(name, sessionId);
      this.cooldown = this.cooldown.filter(entry => entry.name !== name);
      logger.debug(`[SessionNames] Adopted '${name}' for ${sessionId}`);
      return name;
    }

    return this.assign(sessionId, isLeader);
  }

  /**
   * Update an existing session to a canonical preferred name when the new name
   * is available. If another live session already owns that name, the current
   * assignment is preserved to avoid churn.
   */
  reassign(sessionId: string, name: string, isLeader = false): string {
    const existing = this.assigned.get(sessionId);
    if (!existing) {
      return this.adopt(sessionId, name, isLeader);
    }

    if (existing === name) {
      return existing;
    }

    const currentOwner = this.nameToSession.get(name);
    if (currentOwner && currentOwner !== sessionId) {
      return existing;
    }

    this.assigned.delete(sessionId);
    this.nameToSession.delete(existing);
    if (ALL_PUPPET_NAMES.includes(existing)) {
      this.cooldown.push({ name: existing, releasedAt: Date.now() });
    }

    return this.adopt(sessionId, name, isLeader);
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
   * Get the canonical color for an assigned session name.
   */
  getColor(sessionId: string): string | undefined {
    const name = this.assigned.get(sessionId);
    return name ? getPuppetColor(name) : undefined;
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
