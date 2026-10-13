import { type DomainError, domainError, type Err, err } from "../result";

/** `err(VALIDATION)`: malformed input. */
export function validation(
  message: string,
  details: Readonly<Record<string, unknown>>,
): Err<DomainError<"VALIDATION">> {
  return err(domainError("VALIDATION", message, details));
}

/** `err(INVARIANT_VIOLATION)`: the stored records already break the rules. */
export function invariant(
  message: string,
  details: Readonly<Record<string, unknown>>,
): Err<DomainError<"INVARIANT_VIOLATION">> {
  return err(domainError("INVARIANT_VIOLATION", message, details));
}
