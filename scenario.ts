// scenario.ts — deterministic scenario identity.
//
// The scored harness seeds its fixture users from SCENARIO_SEED using the
// generator in the kit's wire.ts. The entry must derive the viewer's login
// itself (the harness never tells it): the token owner is the viewer
// `adaiversen` (id 1000) for every scored instance, because the seed is
// fixed. This module copies the RNG + name lists + generateUsers from
// wire.ts verbatim — no kit files are imported.

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const SCENARIO_EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z
export const U64_MASK = 0xffffffffffffffffn;

/** FNV-1a, 64-bit: a label's stable seed contribution. */
export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: a seeded value with every bit mixed into every other. */
export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from: a stable function of SCENARIO_SEED and the label. */
export function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/**
 * xorshift64*: a 64-bit state walked by three shifts and one multiply, seeded from a bigint. Every
 * method is deterministic and has no hidden state but `#state`.
 */
export class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  /** A stream from a label (scenarioSeedFor) under this scenario's seed. */
  static fromLabel(label: string): Rng {
    return new Rng(scenarioSeedFor(label));
  }

  /** An independent stream from this one's current state. */
  clone(): Rng {
    return new Rng(this.#state);
  }

  /** The next 64-bit value. */
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  /** The next 32-bit value, from the top half of nextU64(). */
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new Error(`nextInt needs a positive safe integer, not ${String(maxExclusive)}`);
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  /** A number in [0, 1), 32 bits of resolution. */
  fraction(): number {
    return this.nextU32() / 4_294_967_296;
  }

  /** True with probability `probability`. */
  chance(probability: number): boolean {
    return this.fraction() < probability;
  }

  /** One element, uniformly (an error on an empty list). */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.nextInt(items.length)];
  }

  /** A shuffled copy, Fisher-Yates. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const swap = copy[i];
      copy[i] = copy[j];
      copy[j] = swap;
    }
    return copy;
  }
}

/** A named stream: same label, same numbers, in any process and any order of use. */
export function scenarioRng(label: string): Rng {
  return new Rng(scenarioSeedFor(label));
}

const FIRST_NAMES: readonly string[] = Object.freeze([
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
]);

const LAST_NAMES: readonly string[] = Object.freeze([
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
]);

const REPO_ADJECTIVES: readonly string[] = Object.freeze([
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
]);

const REPO_NOUNS: readonly string[] = Object.freeze([
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
]);

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** `count` users with unique logins, deterministic for `rng`. */
export function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push(Object.freeze({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` }));
  }
  return users;
}

export const SCENARIO_USERS: ScenarioUser[] = generateUsers(scenarioRng('users'), 12);
export const VIEWER: ScenarioUser = SCENARIO_USERS[0];
export const TEAMMATE: ScenarioUser = SCENARIO_USERS[1];
export const STRANGER: ScenarioUser = SCENARIO_USERS[2];

const orgRng = scenarioRng('org');
export const ORG_NAME = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;
