import { createHash, randomBytes } from "node:crypto";

function format(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A UUIDv7 (RFC 9562): what the phone and the counter form use for payment ids. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return format(bytes);
}

/**
 * A stable v4-shaped install id per (target, login): the same virtual phone on every run, so a
 * lineman keeps one registered load-test device instead of a new one each time.
 */
export function installIdFor(baseUrl: string, login: string): string {
  const bytes = createHash("sha256").update(`cb-load|${baseUrl}|${login}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return format(bytes);
}

/**
 * Provisional receipt references for one run: `P-<device code>-<9 digits>`; the first five digits
 * come from the run's start time, so two runs on the same device don't reuse a reference.
 */
export function provisionalRefs(deviceCode: string, runStartedMs: number): () => string {
  const prefix = String(Math.floor(runStartedMs / 1000) % 100_000).padStart(5, "0");
  let next = 0;
  return () => {
    next = (next + 1) % 10_000;
    return `P-${deviceCode}-${prefix}${String(next).padStart(4, "0")}`;
  };
}

/** India-time calendar day (`YYYY-MM-DD`) of an instant: the lineman's collection day. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
