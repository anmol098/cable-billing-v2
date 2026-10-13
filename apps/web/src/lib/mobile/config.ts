/**
 * Mobile API settings that ship with the server (T-028, PLAN §11.9).
 *
 * **Raising the minimum app version:** set {@link MIN_APP_VERSION_CODE} to the Android
 * `versionCode` every phone must have and deploy. Older apps then get APP_TOO_OLD (426) on every
 * gated endpoint and show only the "Update app" screen; `GET /app/config` and `POST /auth/logout`
 * keep answering them. Payments queued on the phone stay there and sync after the update. Only
 * raise it after that version is live on Google Play (D-19), or linemen can't update.
 */

/** The lowest Android versionCode the API accepts (`min_app_version_code`). */
export const MIN_APP_VERSION_CODE = 1;

/** Feature flags for `GET /app/config` (snake_case name → on). None yet. */
export const MOBILE_FEATURES: Readonly<Record<string, boolean>> = Object.freeze({});
