/** Shared input pieces of the collection services (T-062). */
import {
  type BusinessDate,
  businessDateOf,
  compareBusinessDates,
  isBusinessDate,
} from "@cb/domain";
import { z } from "zod";
import { type ServiceError, serviceError } from "../errors/errors";

/** A UUID in canonical lower case (Postgres returns it so; comparisons stay exact). */
export const idInput = z.uuid().transform((value) => value.toLowerCase());

/** An IST business date `YYYY-MM-DD` (a real calendar date). */
export const businessDateInput = z
  .string()
  .refine(isBusinessDate, { message: "Expected a YYYY-MM-DD business date" })
  .transform((value) => value as BusinessDate);

/** VALIDATION when `date` is after today in IST (contract: "future dates are VALIDATION"). */
export function futureDateError(date: BusinessDate, now: Date): ServiceError<"VALIDATION"> | null {
  if (compareBusinessDates(date, businessDateOf(now)) <= 0) return null;
  return serviceError("VALIDATION", "Business date is in the future", {
    fields: [{ path: "businessDate", code: "future" }],
  });
}
