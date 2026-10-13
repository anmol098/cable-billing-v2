/**
 * Text rules shared by the settings services (T-030): business profile fields and area names.
 * Pure. Values typed into the web forms are normalised here before validation, so the database
 * only ever stores the tidy form.
 */
import { z } from "zod";

/**
 * Control characters other than a line break (tab, ESC, NUL, DEL…). The receipt footer and the
 * business name/phone are printed by the lineman's Bluetooth printer (ESC/POS, T-068): a stored
 * ESC byte would be a printer command, so these are refused everywhere, not only stripped.
 */
function isControl(code: number): boolean {
  return (code < 0x20 && code !== 0x0a) || code === 0x7f;
}

/** True when `value` has no control characters (a line break `\n` is allowed). */
export function hasNoControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (isControl(value.charCodeAt(i))) return false;
  }
  return true;
}

/** One line: runs of whitespace (incl. line breaks and tabs) become one space; trimmed. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Several lines (address, receipt footer): Windows/Mac line ends become `\n`, tabs become spaces,
 * spaces at the end of each line go, at most one blank line in a row, trimmed.
 */
export function multiLine(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A one-line text of 1…`max` characters (after `oneLine`). */
export function requiredLine(max: number) {
  return z
    .string()
    .transform(oneLine)
    .pipe(
      z.string().min(1).max(max).refine(hasNoControlCharacters, { message: "control_characters" }),
    );
}

/** A multi-line text of at most `max` characters; empty → `null`. */
export function optionalText(max: number) {
  return z
    .string()
    .transform(multiLine)
    .pipe(z.string().max(max).refine(hasNoControlCharacters, { message: "control_characters" }))
    .transform((value) => (value === "" ? null : value));
}
