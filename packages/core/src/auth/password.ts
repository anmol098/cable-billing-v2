/**
 * Password hashing (PLAN §9.2, E-04, FR-028): **argon2id** via `@node-rs/argon2`.
 *
 * Why this implementation: it is a maintained N-API binding of the reference Rust `argon2` crate
 * with prebuilt binaries for every platform we run on (Vercel's Node runtime is linux-x64-gnu),
 * shipped as optional platform packages (no install script, no node-gyp), and it is in Next.js's
 * default `serverExternalPackages`, so it is loaded from `node_modules` instead of being bundled.
 * Hashing runs on libuv's thread pool, so it doesn't block the event loop.
 *
 * Parameters: OWASP's argon2id baseline (m = 19 MiB, t = 2, p = 1). Hashes are PHC strings
 * (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`), so the parameters can be raised later and old
 * hashes still verify.
 *
 * Better Auth uses these two functions for every password it hashes or checks (sign-in, reset,
 * 2FA enrolment). Other tasks that store a password (T-027 owner sign-up, T-032 lineman passwords)
 * must call {@link hashPassword} too.
 */
import { type Algorithm, hash, verify } from "@node-rs/argon2";

/** `Algorithm.Argon2id` (an ambient const enum, which isolated modules can't reference). */
const ARGON2ID = 2 as Algorithm;

/** argon2id parameters (OWASP Password Storage Cheat Sheet, 2nd recommended configuration). */
export const ARGON2_PARAMETERS = Object.freeze({
  algorithm: ARGON2ID,
  /** KiB. */
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

/** Shortest password the web accepts (Better Auth's `minPasswordLength`). */
export const PASSWORD_MIN_LENGTH = 8;
/** Longest password accepted (bounds the hashing work an attacker can request). */
export const PASSWORD_MAX_LENGTH = 128;

/** Hashes a password with argon2id and a fresh random salt. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMETERS);
}

/**
 * Checks a password against a stored hash. Returns `false` (never throws) for a wrong password
 * and for a stored value that is not an argon2 PHC string, e.g. an unverified legacy hash: such
 * users must reset their password (FR-028); their old hash is never trusted.
 */
export async function verifyPassword(input: { hash: string; password: string }): Promise<boolean> {
  if (!input.hash.startsWith("$argon2")) {
    // Same cost as a real check, so the response time doesn't reveal a legacy/broken hash.
    await hashPassword(input.password);
    return false;
  }
  try {
    return await verify(input.hash, input.password);
  } catch {
    return false;
  }
}
