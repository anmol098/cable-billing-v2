/**
 * The force-update gate (PLAN §11.9, D-19, T-051 decision 6): the app sends its Android
 * `versionCode` in `x-app-version-code` on every request; below the minimum the server answers
 * APP_TOO_OLD (426) with `min_app_version_code`, except on `GET /app/config` and
 * `POST /auth/logout`, which always answer (the contract marks them `appVersionGate: false`).
 */

/** The header the app sends (same value as `@cb/contracts` `APP_VERSION_HEADER`). */
export const APP_VERSION_CODE_HEADER = "x-app-version-code";

/** The lowest versionCode accepted unless the app passes another (raised by a deploy). */
export const DEFAULT_MIN_APP_VERSION_CODE = 1;

const VERSION_CODE = /^[1-9][0-9]{0,9}$/;
const MAX_VERSION_CODE = 2_100_000_000;

/** The header's versionCode, or `null` when it is missing or malformed. */
export function parseAppVersionCode(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!VERSION_CODE.test(trimmed)) return null;
  const code = Number(trimmed);
  return code <= MAX_VERSION_CODE ? code : null;
}

export type VersionGateResult =
  | { readonly ok: true; readonly appVersionCode: number | null }
  | { readonly ok: false; readonly code: "VALIDATION" }
  | { readonly ok: false; readonly code: "APP_TOO_OLD"; readonly minAppVersionCode: number };

/**
 * Checks the header. `gated: false` (config, logout) never refuses: a missing or malformed header
 * is ignored there. `gated: true` requires a well-formed header (VALIDATION otherwise) that is at
 * least `minAppVersionCode` (APP_TOO_OLD otherwise).
 */
export function checkAppVersion(
  headers: Headers,
  options: { gated: boolean; minAppVersionCode: number },
): VersionGateResult {
  const raw = headers.get(APP_VERSION_CODE_HEADER);
  const code = parseAppVersionCode(raw);
  if (!options.gated) return { ok: true, appVersionCode: code };
  if (code === null) return { ok: false, code: "VALIDATION" };
  if (code < options.minAppVersionCode) {
    return { ok: false, code: "APP_TOO_OLD", minAppVersionCode: options.minAppVersionCode };
  }
  return { ok: true, appVersionCode: code };
}
