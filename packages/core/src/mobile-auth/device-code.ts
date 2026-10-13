/**
 * Device codes (PLAN §7.3, T-021): three characters, unique per operator **forever** (revoked
 * devices keep theirs), printed in provisional receipt references `P-{device_code}-{seq}`.
 *
 * New codes avoid characters people confuse when reading a receipt aloud or over the phone
 * (0/O, 1/I): 32 symbols, 32,768 codes per operator. Codes already in the table (seeded,
 * migrated) may use any `[A-Z0-9]`; the DB CHECK is `^[A-Z0-9]{3}$`.
 */
import { randomInt } from "node:crypto";

export const DEVICE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const DEVICE_CODE_LENGTH = 3;

/** A random code from {@link DEVICE_CODE_ALPHABET}. */
export function randomDeviceCode(): string {
  let code = "";
  for (let i = 0; i < DEVICE_CODE_LENGTH; i += 1) {
    code += DEVICE_CODE_ALPHABET[randomInt(DEVICE_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * A random code not in `taken`, or `null` when every code is taken. Tries random codes first,
 * then scans (only reached when the operator has used most codes).
 */
export function pickFreeDeviceCode(taken: ReadonlySet<string>): string | null {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const code = randomDeviceCode();
    if (!taken.has(code)) return code;
  }
  const n = DEVICE_CODE_ALPHABET.length;
  const start = randomInt(n ** DEVICE_CODE_LENGTH);
  for (let i = 0; i < n ** DEVICE_CODE_LENGTH; i += 1) {
    let value = (start + i) % n ** DEVICE_CODE_LENGTH;
    let code = "";
    for (let d = 0; d < DEVICE_CODE_LENGTH; d += 1) {
      code = (DEVICE_CODE_ALPHABET[value % n] ?? "") + code;
      value = Math.floor(value / n);
    }
    if (!taken.has(code)) return code;
  }
  return null;
}
