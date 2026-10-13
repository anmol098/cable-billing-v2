/** `GET /api/mobile/v1/collections/{date}` (T-061, contract `getCollectionDay`). See `../_lib`. */
import { getMobileDeps } from "@/lib/mobile/server";
import { collectionDayHandler } from "../_lib/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = collectionDayHandler(getMobileDeps);
