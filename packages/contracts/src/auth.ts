/**
 * Lineman sign-in (D-07, PLAN §9.2, §11.6): username + password once per phone, then a 15-minute
 * access token and a 180-day sliding refresh token bound to the device. Implemented by T-028.
 */

import * as z from "zod";
import { responseBody } from "./envelope";
import { Language, Timestamp, Uuid } from "./primitives";

/** Android `versionCode`: what the force-update gate compares. */
export const AppVersionCode = z.int().min(1).max(2_100_000_000).meta({
  description:
    "Android versionCode of the installed app (an integer that grows with every release). The force-update gate compares this, never the version name.",
  example: 12,
});

export const DeviceInfo = z
  .object({
    install_id: Uuid.describe(
      "Random UUID the app makes once per installation and keeps until it is uninstalled. Identifies this phone's install to the server.",
    ),
    model: z
      .string()
      .min(1)
      .max(100)
      .describe(
        "Phone maker and model (Build.MANUFACTURER + Build.MODEL), e.g. 'Xiaomi Redmi 9A'.",
      ),
    os: z.string().min(1).max(50).describe("Android version, e.g. 'Android 13 (API 33)'."),
    app_version: z
      .string()
      .min(1)
      .max(50)
      .describe("App version name for display and support, e.g. '1.0.3'. Not compared."),
    app_version_code: AppVersionCode,
  })
  .meta({ id: "DeviceInfo", description: "The phone signing in (registered in `devices`)." });

export const LoginRequest = z
  .object({
    login: z
      .string()
      .min(1)
      .max(100)
      .describe(
        "The lineman's login (usually their mobile number). Compared case-insensitively after trimming.",
      ),
    password: z.string().min(1).max(256).describe("The password, exactly as typed."),
    device: DeviceInfo.describe("The phone signing in."),
  })
  .meta({ id: "LoginRequest", description: "Sign in a lineman on this phone." });

export type LoginRequest = z.infer<typeof LoginRequest>;

export const TokenPair = z
  .object({
    token_type: z
      .literal("Bearer")
      .describe("Always 'Bearer': send 'Authorization: Bearer <access_token>'."),
    access_token: z
      .string()
      .min(1)
      .max(4096)
      .describe("Short-lived access token (about 15 minutes). Opaque; never parse it."),
    access_token_expires_at: Timestamp.describe(
      "When the access token stops working (UTC). Refresh a little before this, or on UNAUTHENTICATED.",
    ),
    refresh_token: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        "Refresh token for this device (180 days, sliding). Single use: every refresh returns a new one; store it encrypted and replace the old one atomically.",
      ),
    refresh_token_expires_at: Timestamp.describe(
      "When the refresh token expires if it is not used (UTC). Each refresh extends it.",
    ),
  })
  .meta({ id: "TokenPair", description: "Tokens for this phone." });

export const UserInfo = z
  .object({
    id: Uuid.describe("User id."),
    name: z
      .string()
      .min(1)
      .max(200)
      .describe("Display name, printed on receipts as the collector."),
    login: z.string().min(1).max(100).describe("Login (lower-cased)."),
    language: Language.describe("The user's preferred UI language."),
  })
  .meta({ id: "UserInfo", description: "The signed-in lineman." });

export const OperatorInfo = z
  .object({
    id: Uuid.describe("Operator (tenant) id."),
    name: z.string().min(1).max(200).describe("Business name, shown in the app and on receipts."),
    office_phone: z
      .string()
      .max(20)
      .nullable()
      .describe(
        "Office phone for the 'Call office' buttons, digits only (may include a leading +). Null if the operator has not set one.",
      ),
    receipt_footer: z
      .string()
      .max(500)
      .nullable()
      .describe("Footer text the operator wants printed on receipts. Null for none."),
  })
  .meta({ id: "OperatorInfo", description: "The cable operator this lineman works for." });

export const RegisteredDevice = z
  .object({
    id: Uuid.describe("Server id of this device registration. Sent back on payments as device_id."),
    device_code: z
      .string()
      .regex(/^[A-Z0-9]{3}$/)
      .describe(
        "Three-character code unique within the operator, used in provisional receipt references: P-{device_code}-{seq}.",
      )
      .meta({ example: "K7Q" }),
  })
  .meta({ id: "RegisteredDevice", description: "This phone as the server registered it." });

export const LoginResponse = responseBody(
  "LoginResponse",
  "Signed in. Store the tokens encrypted; keep user, operator and device for offline use.",
  {
    tokens: TokenPair.describe("The token pair for this phone. Store it encrypted."),
    user: UserInfo.describe("Who signed in (the collector printed on receipts)."),
    operator: OperatorInfo.describe("The lineman's operator."),
    device: RegisteredDevice.describe("This phone's registration."),
  },
);

export type LoginResponse = z.infer<typeof LoginResponse>;

export const RefreshRequest = z
  .object({
    refresh_token: z.string().min(1).max(4096).describe("The current refresh token."),
    install_id: Uuid.describe("This installation's install_id (must match the token's device)."),
  })
  .meta({
    id: "RefreshRequest",
    description:
      "Swap the refresh token for a new token pair. Reusing an old refresh token revokes the whole token family (REFRESH_TOKEN_INVALID).",
  });

export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const RefreshResponse = responseBody(
  "RefreshResponse",
  "New tokens. The old refresh token no longer works.",
  { tokens: TokenPair.describe("The new tokens; replace both stored tokens.") },
);

export type RefreshResponse = z.infer<typeof RefreshResponse>;

export const LogoutRequest = z
  .object({
    refresh_token: z
      .string()
      .min(1)
      .max(4096)
      .describe("The refresh token to revoke. Works even when the access token has expired."),
  })
  .meta({
    id: "LogoutRequest",
    description:
      "Sign this phone out: revokes the refresh token's family. The app must not delete queued payments (PLAN §9.2).",
  });

export type LogoutRequest = z.infer<typeof LogoutRequest>;

export const LogoutResponse = responseBody(
  "LogoutResponse",
  "Signed out (also returned when the token was already revoked or unknown).",
  {},
);

export type LogoutResponse = z.infer<typeof LogoutResponse>;
