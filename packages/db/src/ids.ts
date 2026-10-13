/**
 * UUIDv7 ids (RFC 9562), generated in the app (PLAN §7.1): pure TypeScript on Web Crypto, so the
 * same code runs in Node, Vercel functions and tests. Postgres 17 has no built-in `uuidv7()`, and
 * the Android app creates payment ids offline, so the database never generates primary keys.
 *
 * Layout: 48-bit Unix milliseconds | version 7 | 12-bit counter (`rand_a`) | variant | 62 random bits.
 * Monotonic within one process (RFC 9562 §6.2 method 1): ids made in the same millisecond bump the
 * counter (seeded randomly in its lower half each millisecond); on counter overflow, or if the
 * clock goes backwards, the timestamp is carried forward instead of going back. So ids from one
 * generator always sort strictly increasing as strings and as `uuid` values. Across processes they
 * are only time-ordered to the millisecond ("monotonic-ish"), which is all the B-tree locality and
 * rough creation-order sorting need. Never use id order as business order: use timestamps.
 */
import { uuid } from "drizzle-orm/pg-core";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_COUNTER = 0xfff;
const SEED_MASK = 0x7ff; // seed in the lower half, leaving room to count up within the millisecond
const MAX_TIMESTAMP = 2 ** 48 - 1;

export interface UuidV7GeneratorOptions {
  /** Clock in Unix milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Fills a buffer with random bytes. Defaults to `crypto.getRandomValues`. */
  random?: (bytes: Uint8Array) => void;
}

const defaultRandom = (bytes: Uint8Array): void => {
  globalThis.crypto.getRandomValues(bytes);
};

/** Creates an independent monotonic UUIDv7 generator (tests inject a clock and randomness). */
export function createUuidV7Generator(options: UuidV7GeneratorOptions = {}): () => string {
  const now = options.now ?? Date.now;
  const random = options.random ?? defaultRandom;
  let lastMs = -1;
  let counter = 0;
  const bytes = new Uint8Array(16);

  return function nextUuidV7(): string {
    const clock = Math.floor(now());
    if (!Number.isSafeInteger(clock) || clock < 0 || clock > MAX_TIMESTAMP) {
      throw new RangeError("uuidv7: clock is out of range");
    }
    random(bytes);
    if (clock > lastMs) {
      lastMs = clock;
      counter = (((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0)) & SEED_MASK;
    } else {
      // Same millisecond, or the clock went backwards: stay on lastMs and count up.
      counter += 1;
      if (counter > MAX_COUNTER) {
        lastMs += 1; // borrow the next millisecond rather than repeat or go back
        counter = (((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0)) & SEED_MASK;
      }
    }
    if (lastMs > MAX_TIMESTAMP) throw new RangeError("uuidv7: timestamp overflow");

    // 48-bit big-endian timestamp. 2^48 is beyond 32-bit bit ops, so split with division.
    const high = Math.floor(lastMs / 2 ** 16);
    const low = lastMs % 2 ** 16;
    bytes[0] = (high >>> 24) & 0xff;
    bytes[1] = (high >>> 16) & 0xff;
    bytes[2] = (high >>> 8) & 0xff;
    bytes[3] = high & 0xff;
    bytes[4] = (low >>> 8) & 0xff;
    bytes[5] = low & 0xff;
    bytes[6] = 0x70 | ((counter >>> 8) & 0x0f); // version 7 + counter high bits
    bytes[7] = counter & 0xff;
    bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 4122/9562 variant 0b10

    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/** Returns a new UUIDv7 (lower-case, hyphenated). Monotonic within this process. */
export const uuidv7: () => string = createUuidV7Generator();

/** True for any well-formed UUID string (any version), e.g. to validate ids from the client. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** True for a well-formed version-7 UUID with the RFC variant. */
export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_RE.test(value);
}

/** The creation time embedded in a UUIDv7. Throws for anything that is not a UUIDv7. */
export function uuidV7Timestamp(id: string): Date {
  if (!isUuidV7(id)) throw new TypeError("uuidV7Timestamp: not a UUIDv7");
  const hex = id.slice(0, 8) + id.slice(9, 13);
  return new Date(Number.parseInt(hex, 16));
}

/**
 * Primary-key column for every table: `id uuid primary key`, filled with {@link uuidv7} on insert
 * when the app doesn't pass one (payments pass the client-made id).
 */
export const primaryId = () => uuid("id").primaryKey().$defaultFn(uuidv7);
