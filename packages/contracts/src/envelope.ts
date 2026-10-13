import * as z from "zod";
import { Timestamp } from "./primitives";

/** `server_time`: carried by every response, success or error (PLAN §10.2). */
export const ServerTime = Timestamp.describe(
  "Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'.",
);

/**
 * A success response body: `server_time` plus the endpoint's own fields, registered as an OpenAPI
 * component named `id`.
 */
export function responseBody<const Shape extends z.ZodRawShape>(
  id: string,
  description: string,
  shape: Shape,
) {
  return z.object({ server_time: ServerTime, ...shape }).meta({ id, description });
}
