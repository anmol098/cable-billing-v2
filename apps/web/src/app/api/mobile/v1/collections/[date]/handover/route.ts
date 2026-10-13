/** `POST /api/mobile/v1/collections/{date}/handover` (T-061, contract `submitHandover`). See `../../_lib`. */
import { getMobileDeps } from "@/lib/mobile/server";
import { submitHandoverHandler } from "../../_lib/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = submitHandoverHandler(getMobileDeps);
