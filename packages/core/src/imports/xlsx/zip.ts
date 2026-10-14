/**
 * Reading and writing the ZIP container of an .xlsx file (T-084), on top of `fflate`.
 *
 * Reading uses the central directory (always present and reliable, also for files written with
 * data descriptors) and inflates only the parts asked for, **in small steps with a byte limit per
 * part**: a "zip bomb" (a few KB that inflate to gigabytes, or a header that lies about the size)
 * stops at the limit instead of filling the server's memory. ZIP64, encryption and compression
 * methods other than stored/deflate are refused (an .xlsx of at most a few MB never needs them).
 */
import { Inflate, strToU8, zipSync } from "fflate";

export class ZipError extends Error {
  constructor(
    readonly reason: "not_zip" | "too_big" | "unsupported" | "corrupt",
    message: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly compressedSize: number;
  readonly localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ENTRIES = 5000;
/** Compressed bytes inflated per step (bounds the memory one step can produce). */
const INFLATE_STEP = 16 * 1024;

function u16(data: Uint8Array, at: number): number {
  if (at + 2 > data.length) throw new ZipError("corrupt", "read past the end");
  return (data[at] ?? 0) | ((data[at + 1] ?? 0) << 8);
}

function u32(data: Uint8Array, at: number): number {
  if (at + 4 > data.length) throw new ZipError("corrupt", "read past the end");
  return (
    ((data[at] ?? 0) |
      ((data[at + 1] ?? 0) << 8) |
      ((data[at + 2] ?? 0) << 16) |
      ((data[at + 3] ?? 0) << 24)) >>>
    0
  );
}

/** True when the bytes start like a ZIP file (`PK\3\4`). */
export function looksLikeZip(data: Uint8Array): boolean {
  return data.length >= 4 && u32(data, 0) === LOCAL_SIGNATURE;
}

const utf8 = new TextDecoder("utf-8");

function centralDirectory(data: Uint8Array): Map<string, CentralEntry> {
  let eocd = -1;
  const lowest = Math.max(0, data.length - 22 - 0xffff);
  for (let at = data.length - 22; at >= lowest; at -= 1) {
    if (u32(data, at) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) throw new ZipError("not_zip", "no end of central directory");
  const count = u16(data, eocd + 10);
  let offset = u32(data, eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new ZipError("unsupported", "ZIP64");
  if (count > MAX_ENTRIES) throw new ZipError("too_big", "too many entries");
  const entries = new Map<string, CentralEntry>();
  for (let index = 0; index < count; index += 1) {
    if (u32(data, offset) !== CENTRAL_SIGNATURE) throw new ZipError("corrupt", "bad entry");
    const flags = u16(data, offset + 8);
    const method = u16(data, offset + 10);
    const compressedSize = u32(data, offset + 20);
    const nameLength = u16(data, offset + 28);
    const extraLength = u16(data, offset + 30);
    const commentLength = u16(data, offset + 32);
    const localHeaderOffset = u32(data, offset + 42);
    if (offset + 46 + nameLength > data.length) throw new ZipError("corrupt", "bad name");
    const name = utf8.decode(data.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { name, method, flags, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function inflateLimited(compressed: Uint8Array, maxBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflate = new Inflate((chunk) => {
    total += chunk.length;
    if (total > maxBytes) throw new ZipError("too_big", "part inflates past its limit");
    chunks.push(chunk);
  });
  try {
    for (let at = 0; at < compressed.length; at += INFLATE_STEP) {
      const end = Math.min(at + INFLATE_STEP, compressed.length);
      inflate.push(compressed.subarray(at, end), end === compressed.length);
    }
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError("corrupt", "inflate failed");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The parts of a ZIP file, read on demand with a size limit each. */
export interface ZipReader {
  has(name: string): boolean;
  /** The part's bytes, or `null` when there is no such part. Throws {@link ZipError}. */
  read(name: string, maxBytes: number): Uint8Array | null;
}

export function openZip(data: Uint8Array): ZipReader {
  if (!looksLikeZip(data)) throw new ZipError("not_zip", "no ZIP signature");
  const entries = centralDirectory(data);
  return {
    has: (name) => entries.has(name),
    read(name, maxBytes) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.flags & 0x1) throw new ZipError("unsupported", "encrypted");
      const local = entry.localHeaderOffset;
      if (u32(data, local) !== LOCAL_SIGNATURE) throw new ZipError("corrupt", "bad local header");
      const start = local + 30 + u16(data, local + 26) + u16(data, local + 28);
      const end = start + entry.compressedSize;
      if (end > data.length) throw new ZipError("corrupt", "part past the end");
      const compressed = data.subarray(start, end);
      if (entry.method === 0) {
        if (compressed.length > maxBytes) throw new ZipError("too_big", "stored part too big");
        return compressed.slice();
      }
      if (entry.method === 8) return inflateLimited(compressed, maxBytes);
      throw new ZipError("unsupported", "compression method");
    },
  };
}

/** Zips text parts (deflated). */
export function zipTextParts(parts: Readonly<Record<string, string>>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(parts)) files[name] = strToU8(text);
  // A fixed timestamp: the same input gives the same bytes (tests, caching).
  return zipSync(files, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") });
}
