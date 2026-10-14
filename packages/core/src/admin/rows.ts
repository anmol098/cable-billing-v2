/** Small converters for raw SQL rows (drivers return timestamps and bigints differently). */

export function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function asInt(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") return Number.parseInt(value, 10);
  return 0;
}

/** `part / whole` rounded to one decimal of a percent, or null when `whole` is 0. */
export function percent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}
